import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Config } from './config.ts';
import type { DB, User } from './db.ts';
import { getUser } from './db.ts';
import type { LLM } from './llm.ts';
import type { Transcriber } from './asr.ts';
import { AUDIO_MIME_RE } from './asr.ts';
import { commitResult, runAgent, saveSteps } from './agent.ts';
import { auditQuota, failAndRefund, quotaView, reserve } from './quota.ts';
import { dayKey, formatLocal } from './time.ts';

type Ctx = {
  db: DB;
  llm: LLM;
  config: Config;
  publicDir: string;
  now?: () => Date;
  transcribe?: Transcriber;
  asrLimit?: (key: string) => boolean;
};

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw Object.assign(new Error('body too large'), { status: 413 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 32 * 1024): Promise<any> {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

/** 语音转写：浏览器录音（模拟硬件按键录音）→ 千问 ASR → 文字。不占 AI 处理额度，单独限流。 */
async function handleTranscribe(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: User) {
  if (!ctx.transcribe) return sendJson(res, 503, { error: 'asr_unavailable' });
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_MIME_RE.test(mime)) return sendJson(res, 415, { error: 'unsupported_audio', message: `不支持的音频格式：${mime || '未知'}` });
  if (ctx.asrLimit && !ctx.asrLimit(user.id)) return sendJson(res, 429, { error: 'asr_rate_limited', message: '转写太频繁，请稍后再试' });
  const audio = await readBody(req, ctx.config.asr.maxBytes);
  if (audio.length < 1000) return sendJson(res, 400, { error: 'audio_too_short', message: '录音太短' });
  const t0 = Date.now();
  try {
    const text = await ctx.transcribe(audio, mime);
    return sendJson(res, 200, { text, ms: Date.now() - t0, bytes: audio.length });
  } catch (err) {
    return sendJson(res, 502, { error: 'asr_failed', message: `转写失败：${err instanceof Error ? err.message : String(err)}` });
  }
}

/** 演示用身份：请求头 x-user-id 选择种子用户。真实产品换成登录态，额度逻辑不变。 */
function auth(ctx: Ctx, req: IncomingMessage): User | undefined {
  const id = req.headers['x-user-id'];
  return typeof id === 'string' ? getUser(ctx.db, id) : undefined;
}

function noteDetail(ctx: Ctx, user: User, noteId: number) {
  const db = ctx.db;
  const tz = user.timezone;
  const note = db.prepare('SELECT id, request_id, input, summary, reply, created_at FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id) as any;
  if (!note) return null;
  const todos = db.prepare('SELECT id, title, due_date, done FROM todos WHERE note_id = ? ORDER BY id').all(noteId) as any[];
  const reminders = (db.prepare('SELECT id, title, remind_at FROM reminders WHERE note_id = ? ORDER BY id').all(noteId) as any[]).map((r) => ({
    ...r,
    remind_at_local: formatLocal(new Date(r.remind_at), tz),
  }));
  const events = (db.prepare('SELECT id, title, start_at, end_at, location FROM events WHERE note_id = ? ORDER BY id').all(noteId) as any[]).map((e) => ({
    ...e,
    start_local: formatLocal(new Date(e.start_at), tz),
    end_local: formatLocal(new Date(e.end_at), tz),
  }));
  return { ...note, created_local: formatLocal(new Date(note.created_at), tz), todos, reminders, events };
}

async function handleCreateNote(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: User) {
  const body = await readJson(req);
  const requestId = body?.requestId;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return sendJson(res, 400, { error: 'invalid_request_id' });
  if (!text || text.length > 2000) return sendJson(res, 400, { error: 'text 长度需在 1–2000 字之间' });

  const now = ctx.now?.() ?? new Date();
  const limit = ctx.config.freeDailyLimit;
  const r = reserve(ctx.db, { userId: user.id, requestId, input: text, now, limit });

  if (r.kind === 'exceeded') return sendJson(res, 429, { error: 'quota_exceeded', message: `今日免费额度（${limit} 次）已用完`, quota: r.quota });
  if (r.kind === 'conflict') return sendJson(res, 422, { error: 'request_id_reused', message: '同一个 requestId 不能用于不同内容' });
  if (r.kind === 'duplicate_processing') return sendJson(res, 409, { error: 'in_progress', message: '这条请求正在处理中，不会重复扣次' });

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const emit = (obj: unknown) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + '\n');
  };

  if (r.kind === 'duplicate_done') {
    emit({ type: 'done', replayed: true, note: noteDetail(ctx, user, r.noteId), quota: quotaView(ctx.db, user, now, limit) });
    return res.end();
  }

  emit({ type: 'accepted', requestId, attempt: r.attempt, charged: r.charged, quota: quotaView(ctx.db, user, now, limit) });
  // 客户端断开也继续处理：结果落库，客户端用同一个 requestId 重发即可拿到结果，不会重复扣次
  try {
    const output = await runAgent({ db: ctx.db, user, input: text, now, llm: ctx.llm, onStep: (step) => emit({ type: 'step', step }) });
    saveSteps(ctx.db, user.id, requestId, r.attempt, output.steps, now);
    const noteId = commitResult(ctx.db, { user, requestId, input: text, output, now: ctx.now?.() ?? new Date() });
    emit({ type: 'done', replayed: false, note: noteDetail(ctx, user, noteId), quota: quotaView(ctx.db, user, now, limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refunded = failAndRefund(ctx.db, { userId: user.id, requestId, error: message, now: ctx.now?.() ?? new Date() });
    emit({ type: 'error', message: `处理失败：${message}`, refunded: refunded && r.charged, quota: quotaView(ctx.db, user, now, limit) });
  }
  res.end();
}

function listItems(ctx: Ctx, user: User) {
  const db = ctx.db;
  const tz = user.timezone;
  const todos = db.prepare('SELECT id, note_id, title, due_date, done FROM todos WHERE user_id = ? ORDER BY done, id DESC LIMIT 100').all(user.id);
  const reminders = (db.prepare('SELECT id, note_id, title, remind_at FROM reminders WHERE user_id = ? ORDER BY remind_at LIMIT 100').all(user.id) as any[]).map(
    (r) => ({ ...r, remind_at_local: formatLocal(new Date(r.remind_at), tz) }),
  );
  const events = (db.prepare('SELECT id, note_id, title, start_at, end_at, location FROM events WHERE user_id = ? ORDER BY start_at LIMIT 100').all(user.id) as any[]).map(
    (e) => ({ ...e, start_local: formatLocal(new Date(e.start_at), tz), end_local: formatLocal(new Date(e.end_at), tz) }),
  );
  return { todos, reminders, events };
}

async function serveStatic(ctx: Ctx, pathname: string, res: ServerResponse) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(ctx.publicDir, rel));
  if (!file.startsWith(ctx.publicDir)) return sendJson(res, 404, { error: 'not_found' });
  try {
    const data = await readFile(file);
    // Vite 产物文件名带内容哈希，可长期缓存；index.html 每次校验
    const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cache });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

export function createHandler(ctx: Ctx) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (!path.startsWith('/api/')) return await serveStatic(ctx, path, res);
      if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, pid: process.pid });
      if (req.method === 'GET' && path === '/api/users') {
        return sendJson(res, 200, ctx.db.prepare('SELECT id, name, plan FROM users ORDER BY id').all());
      }

      const user = auth(ctx, req);
      if (!user) return sendJson(res, 401, { error: 'unknown_user' });
      const now = ctx.now?.() ?? new Date();

      if (req.method === 'GET' && path === '/api/me') {
        return sendJson(res, 200, { user, quota: quotaView(ctx.db, user, now, ctx.config.freeDailyLimit), model: ctx.config.llm.mock ? 'mock' : ctx.config.llm.model });
      }
      if (req.method === 'GET' && path === '/api/quota/audit') {
        const day = url.searchParams.get('day') ?? dayKey(now, user.timezone);
        return sendJson(res, 200, { day, ...auditQuota(ctx.db, user.id, day) });
      }
      if (req.method === 'POST' && path === '/api/notes') return await handleCreateNote(ctx, req, res, user);
      if (req.method === 'POST' && path === '/api/transcribe') return await handleTranscribe(ctx, req, res, user);
      if (req.method === 'GET' && path === '/api/notes') {
        const ids = ctx.db.prepare('SELECT id FROM notes WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 30').all(user.id) as { id: number }[];
        return sendJson(res, 200, ids.map((r) => noteDetail(ctx, user, r.id)));
      }
      const stepsMatch = path.match(/^\/api\/notes\/(\d+)\/steps$/);
      if (req.method === 'GET' && stepsMatch) {
        const note = ctx.db.prepare('SELECT request_id FROM notes WHERE id = ? AND user_id = ?').get(Number(stepsMatch[1]), user.id) as any;
        if (!note) return sendJson(res, 404, { error: 'not_found' });
        const rows = ctx.db
          .prepare('SELECT attempt, payload FROM agent_steps WHERE user_id = ? AND request_id = ? ORDER BY attempt, seq')
          .all(user.id, note.request_id) as { attempt: number; payload: string }[];
        return sendJson(res, 200, rows.map((r) => ({ attempt: r.attempt, ...JSON.parse(r.payload) })));
      }
      if (req.method === 'GET' && path === '/api/items') return sendJson(res, 200, listItems(ctx, user));

      const todoMatch = path.match(/^\/api\/todos\/(\d+)$/);
      if (req.method === 'PATCH' && todoMatch) {
        const body = await readJson(req);
        const r = ctx.db.prepare('UPDATE todos SET done = ? WHERE id = ? AND user_id = ?').run(body?.done ? 1 : 0, Number(todoMatch[1]), user.id);
        return sendJson(res, r.changes ? 200 : 404, { ok: r.changes > 0 });
      }
      const delMatch = path.match(/^\/api\/(todos|reminders|events)\/(\d+)$/);
      if (req.method === 'DELETE' && delMatch) {
        const r = ctx.db.prepare(`DELETE FROM ${delMatch[1]} WHERE id = ? AND user_id = ?`).run(Number(delMatch[2]), user.id);
        return sendJson(res, r.changes ? 200 : 404, { ok: r.changes > 0 });
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (err: any) {
      if (!res.headersSent) return sendJson(res, err?.status ?? 500, { error: err?.message ?? 'internal_error' });
      res.end();
    }
  };
}
