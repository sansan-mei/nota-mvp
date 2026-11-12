/**
 * 额度准确性证明：起 3 个服务进程共用同一个 SQLite 文件（模拟多实例部署），
 * 用离线假模型（每次处理 200ms，放大并发窗口），跑四个真实 HTTP 场景并对账。
 *
 *   node scripts/quota-proof.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Resp = { status: number; final: any };

export type ProofReport = {
  concurrent: { sent: number; done: number; rejected429: number; other: number; audit: any };
  duplicate: { sent: number; done: number; replayed: number; inProgress409: number; audit: any };
  failure: { status: number; refunded: boolean; usedBefore: number; usedAfter: number };
  disconnect: { firstAborted: boolean; replayed: boolean; usedDelta: number; audit: any };
};

async function startServers(n: number, dbPath: string): Promise<{ urls: string[]; procs: ChildProcess[] }> {
  const procs: ChildProcess[] = [];
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const port = 39100 + Math.floor(Math.random() * 800) + i;
    const p = spawn(process.execPath, [join(ROOT, 'src/server.ts')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, LLM_MOCK: '1', LLM_MOCK_DELAY_MS: '200', FREE_DAILY_LIMIT: '10', LLM_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    urls.push(`http://127.0.0.1:${port}`);
  }
  for (const url of urls) {
    for (let t = 0; ; t++) {
      try {
        if ((await fetch(`${url}/api/health`)).ok) break;
      } catch {}
      if (t > 100) throw new Error(`server ${url} not ready`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { urls, procs };
}

async function post(url: string, user: string, requestId: string, text: string, signal?: AbortSignal): Promise<Resp> {
  const res = await fetch(`${url}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': user },
    body: JSON.stringify({ requestId, text }),
    signal,
  });
  const body = await res.text();
  if (res.headers.get('content-type')?.includes('ndjson')) {
    const lines = body.trim().split('\n').map((l) => JSON.parse(l));
    return { status: res.status, final: lines[lines.length - 1] };
  }
  return { status: res.status, final: JSON.parse(body) };
}

const audit = async (url: string, user: string) =>
  (await fetch(`${url}/api/quota/audit`, { headers: { 'x-user-id': user } })).json();
const used = async (url: string, user: string) =>
  (await (await fetch(`${url}/api/me`, { headers: { 'x-user-id': user } })).json()).quota.used as number;

export async function runProof(): Promise<ProofReport> {
  const dir = mkdtempSync(join(tmpdir(), 'nota-proof-'));
  const { urls, procs } = await startServers(3, join(dir, 'proof.db'));
  const pick = (i: number) => urls[i % urls.length];
  try {
    // 场景 1：40 个不同请求同时打到 3 个进程 → 必须恰好 10 个成功
    const r1 = await Promise.all(Array.from({ length: 40 }, (_, i) => post(pick(i), 'u_free_1', randomUUID(), `并发请求 ${i}`)));
    const concurrent = {
      sent: 40,
      done: r1.filter((r) => r.status === 200 && r.final.type === 'done').length,
      rejected429: r1.filter((r) => r.status === 429).length,
      other: r1.filter((r) => !(r.status === 429 || (r.status === 200 && r.final.type === 'done'))).length,
      audit: await audit(urls[0], 'u_free_1'),
    };

    // 场景 2：同一个 requestId 并发重复提交 10 次 + 事后再重放 5 次 → 只扣 1 次、只生成 1 条便签
    const rid = randomUUID();
    const r2 = await Promise.all(Array.from({ length: 10 }, (_, i) => post(pick(i), 'u_free_2', rid, '同一条录音')));
    for (let i = 0; i < 5; i++) r2.push(await post(pick(i), 'u_free_2', rid, '同一条录音'));
    const duplicate = {
      sent: r2.length,
      done: r2.filter((r) => r.status === 200 && r.final.type === 'done' && !r.final.replayed).length,
      replayed: r2.filter((r) => r.status === 200 && r.final.replayed).length,
      inProgress409: r2.filter((r) => r.status === 409).length,
      audit: await audit(urls[0], 'u_free_2'),
    };

    // 场景 3：第三方模型故障 → 处理失败，额度返还
    const before = await used(urls[0], 'u_free_2');
    const r3 = await post(urls[1], 'u_free_2', randomUUID(), '这条会失败 #fail');
    const failure = { status: r3.status, refunded: r3.final.type === 'error' && r3.final.refunded === true, usedBefore: before, usedAfter: await used(urls[0], 'u_free_2') };

    // 场景 4：客户端处理中途断网 → 服务端继续处理；客户端用同一个 requestId 重发拿到结果，不重复扣次
    const before4 = await used(urls[0], 'u_free_2');
    const rid4 = randomUUID();
    let firstAborted = false;
    try {
      await post(urls[2], 'u_free_2', rid4, '断网重试的录音', AbortSignal.timeout(60));
    } catch {
      firstAborted = true;
    }
    await new Promise((r) => setTimeout(r, 600));
    const r4 = await post(urls[0], 'u_free_2', rid4, '断网重试的录音');
    const disconnect = {
      firstAborted,
      replayed: r4.status === 200 && r4.final.replayed === true,
      usedDelta: (await used(urls[0], 'u_free_2')) - before4,
      audit: await audit(urls[0], 'u_free_2'),
    };
    return { concurrent, duplicate, failure, disconnect };
  } finally {
    for (const p of procs) p.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runProof();
  const ok = (b: boolean) => (b ? '✅' : '❌');
  console.log('\n额度准确性证明（3 个进程共用一个数据库，假模型每次处理 200ms）\n');
  console.log(`1. 并发：40 个不同请求同时发出 → 成功 ${r.concurrent.done}，429 拒绝 ${r.concurrent.rejected429}，其他 ${r.concurrent.other}  ${ok(r.concurrent.done === 10 && r.concurrent.rejected429 === 30)}`);
  console.log(`   对账：used=${r.concurrent.audit.used} 流水合计=${r.concurrent.audit.ledgerSum} 扣次请求=${r.concurrent.audit.chargedRequests} 便签=${r.concurrent.audit.notes}  ${ok(r.concurrent.audit.consistent && r.concurrent.audit.used === 10)}`);
  console.log(`2. 重复提交：同一 requestId 发 ${r.duplicate.sent} 次 → 实际处理 ${r.duplicate.done}，返回原结果 ${r.duplicate.replayed}，处理中 409 ${r.duplicate.inProgress409}  ${ok(r.duplicate.done === 1)}`);
  console.log(`   对账：used=${r.duplicate.audit.used} 便签=${r.duplicate.audit.notes}  ${ok(r.duplicate.audit.used === 1 && r.duplicate.audit.notes === 1)}`);
  console.log(`3. 模型故障：返还=${r.failure.refunded}，used ${r.failure.usedBefore} → ${r.failure.usedAfter}  ${ok(r.failure.refunded && r.failure.usedBefore === r.failure.usedAfter)}`);
  console.log(`4. 客户端断线后重发：首次中断=${r.disconnect.firstAborted}，重发拿到原结果=${r.disconnect.replayed}，额度变化 +${r.disconnect.usedDelta}  ${ok(r.disconnect.replayed && r.disconnect.usedDelta === 1)}`);
  console.log(`   最终对账一致：${ok(r.disconnect.audit.consistent)}\n`);
}
