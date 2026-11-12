/**
 * Agent 效果评估：固定“当前时间”和历史数据，用真实模型跑 cases.json，逐条按规则判分。
 * 改 prompt 或换模型后各跑一次，比较通过率（结果保存在 eval/results/，便于对比）。
 *
 *   node eval/run-eval.ts            # 每条跑 1 次
 *   node eval/run-eval.ts --runs 3   # 每条跑 3 次，看稳定性
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, readConfig } from '../src/config.ts';
import { getUser, openDb } from '../src/db.ts';
import { createLLM } from '../src/llm.ts';
import { runAgent, type AgentOutput } from '../src/agent.ts';
import { formatLocal } from '../src/time.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotEnv(join(HERE, '..', '.env'));
const cfg = readConfig();
const llm = createLLM(cfg.llm);
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;

// 固定在 2026-11-12（周四）10:00，期望值才稳定
const NOW = new Date('2026-11-12T10:00:00+08:00');
const TZ = 'Asia/Shanghai';

type Expect = {
  tools_include?: string[];
  tools_exclude?: string[];
  event_start?: string;
  reminder_at?: string;
  todo_due?: string;
  todo_count_min?: number;
  reply_contains_any?: string[];
  reply_contains_all?: string[];
  reply_not_contains_regex?: string;
};
type Case = { id: string; input: string; expect: Expect };

function freshDb() {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO notes (user_id, request_id, input, summary, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('u_free_1', 'h1', '刚跟张总通完电话，报价我给的是每台 128 元，500 台起订，含税不含运费。', '张总询价：每台 128 元，500 台起订', '2026-10-10T03:00:00Z');
  ins.run('u_free_1', 'h2', '张总回电话了，砍价到每台 118 元，起订量降到 300 台，我说要跟财务确认。', '张总还价：118 元/台、起订 300 台', '2026-10-16T03:00:00Z');
  ins.run('u_free_1', 'h3', '李经理说展会展位在 3 号馆，需要准备 20 台演示机。', '展会 3 号馆，20 台演示机', '2026-11-06T03:00:00Z');
  return db;
}

function judge(c: Case, out: AgentOutput): string[] {
  const e = c.expect;
  const fails: string[] = [];
  const tools = out.steps.filter((s) => s.kind === 'tool' && (s.result as any)?.ok).map((s) => (s as any).name as string);
  for (const t of e.tools_include ?? []) if (!tools.includes(t)) fails.push(`缺少工具 ${t}`);
  for (const t of e.tools_exclude ?? []) if (tools.includes(t)) fails.push(`不该调用 ${t}`);
  const fmt = (iso: string) => formatLocal(new Date(iso), TZ).slice(0, 16);
  if (e.event_start && !out.draft.events.some((x) => fmt(x.start_at) === e.event_start))
    fails.push(`日程时间应为 ${e.event_start}，实际 ${out.draft.events.map((x) => fmt(x.start_at)).join(',') || '无'}`);
  if (e.reminder_at && !out.draft.reminders.some((x) => fmt(x.remind_at) === e.reminder_at))
    fails.push(`提醒时间应为 ${e.reminder_at}，实际 ${out.draft.reminders.map((x) => fmt(x.remind_at)).join(',') || '无'}`);
  if (e.todo_due && !out.draft.todos.some((x) => x.due_date === e.todo_due))
    fails.push(`待办截止应为 ${e.todo_due}，实际 ${out.draft.todos.map((x) => x.due_date).join(',') || '无'}`);
  if (e.todo_count_min && out.draft.todos.length < e.todo_count_min) fails.push(`待办至少 ${e.todo_count_min} 条，实际 ${out.draft.todos.length}`);
  if (e.reply_contains_any && !e.reply_contains_any.some((k) => out.reply.includes(k))) fails.push(`回复应包含其一：${e.reply_contains_any.join('/')}`);
  for (const k of e.reply_contains_all ?? []) if (!out.reply.includes(k)) fails.push(`回复应包含 ${k}`);
  if (e.reply_not_contains_regex && new RegExp(e.reply_not_contains_regex).test(out.reply)) fails.push('回复疑似编造了数字');
  return fails;
}

const cases: Case[] = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));
const results: any[] = [];
let passed = 0;
let total = 0;
let ms = 0;

console.log(`模型 ${cfg.llm.mock ? 'mock' : cfg.llm.model}，${cases.length} 条用例 × ${runs} 次\n`);
for (const c of cases) {
  for (let i = 0; i < runs; i++) {
    const db = freshDb();
    const user = getUser(db, 'u_free_1')!;
    const t0 = Date.now();
    let fails: string[];
    let out: AgentOutput | null = null;
    try {
      out = await runAgent({ db, user, input: c.input, now: NOW, llm });
      fails = judge(c, out);
    } catch (err) {
      fails = [`异常：${err instanceof Error ? err.message : String(err)}`];
    }
    const dt = Date.now() - t0;
    ms += dt;
    total++;
    if (fails.length === 0) passed++;
    results.push({ id: c.id, run: i + 1, pass: fails.length === 0, fails, ms: dt, reply: out?.reply, steps: out?.steps });
    console.log(`${fails.length === 0 ? '✅' : '❌'} ${c.id.padEnd(24)} ${String(dt).padStart(5)}ms  ${fails.join('；')}`);
  }
}

const summary = { model: cfg.llm.mock ? 'mock' : cfg.llm.model, passed, total, passRate: +(passed / total).toFixed(3), avgMs: Math.round(ms / total), at: new Date().toISOString() };
console.log(`\n通过 ${passed}/${total}（${(summary.passRate * 100).toFixed(1)}%），平均耗时 ${summary.avgMs}ms`);
mkdirSync(join(HERE, 'results'), { recursive: true });
const file = join(HERE, 'results', `${summary.at.replace(/[:.]/g, '-')}-${summary.model}.json`);
writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
console.log(`明细已保存：${file}`);
