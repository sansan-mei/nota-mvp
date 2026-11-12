import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProof } from '../scripts/quota-proof.ts';

test('真实 HTTP + 3 个进程共用数据库：并发、重复提交、故障返还、断线重发', { timeout: 60_000 }, async () => {
  const r = await runProof();

  assert.equal(r.concurrent.done, 10, '40 个并发请求应恰好成功 10 个');
  assert.equal(r.concurrent.rejected429, 30);
  assert.equal(r.concurrent.audit.used, 10);
  assert.ok(r.concurrent.audit.consistent, 'used / 流水 / 请求三方对账一致');
  assert.equal(r.concurrent.audit.notes, 10);

  assert.equal(r.duplicate.done, 1, '同一 requestId 只处理一次');
  assert.equal(r.duplicate.done + r.duplicate.replayed + r.duplicate.inProgress409, r.duplicate.sent);
  assert.equal(r.duplicate.audit.used, 1);
  assert.equal(r.duplicate.audit.notes, 1);

  assert.ok(r.failure.refunded);
  assert.equal(r.failure.usedAfter, r.failure.usedBefore);

  assert.ok(r.disconnect.firstAborted);
  assert.ok(r.disconnect.replayed);
  assert.equal(r.disconnect.usedDelta, 1);
  assert.ok(r.disconnect.audit.consistent);
});
