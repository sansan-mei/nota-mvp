import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { auditQuota, failAndRefund, reserve, sweepStale } from '../src/quota.ts';

const NOW = new Date('2026-11-12T10:00:00+08:00');
const fresh = () => openDb(':memory:');

test('超过 10 次被拒绝，流水与计数一致', () => {
  const db = fresh();
  const results = Array.from({ length: 12 }, (_, i) => reserve(db, { userId: 'u_free_1', requestId: `req-${i}-xxxx`, input: `t${i}`, now: NOW, limit: 10 }).kind);
  assert.equal(results.filter((k) => k === 'reserved').length, 10);
  assert.equal(results.filter((k) => k === 'exceeded').length, 2);
  const a = auditQuota(db, 'u_free_1', '2026-11-12');
  assert.equal(a.used, 10);
  assert.equal(a.ledgerSum, 10);
  assert.ok(a.consistent);
});

test('同一 requestId：处理中返回 duplicate_processing，不扣次；内容不同返回 conflict', () => {
  const db = fresh();
  const args = { userId: 'u_free_1', requestId: 'same-req-1', input: 'hello', now: NOW, limit: 10 };
  assert.equal(reserve(db, args).kind, 'reserved');
  assert.equal(reserve(db, args).kind, 'duplicate_processing');
  assert.equal(reserve(db, { ...args, input: 'other' }).kind, 'conflict');
  assert.equal(auditQuota(db, 'u_free_1', '2026-11-12').used, 1);
});

test('失败返还只发生一次；失败后用同一 requestId 重试会重新扣次', () => {
  const db = fresh();
  const args = { userId: 'u_free_1', requestId: 'retry-req-1', input: 'hello', now: NOW, limit: 10 };
  reserve(db, args);
  assert.equal(failAndRefund(db, { userId: 'u_free_1', requestId: 'retry-req-1', error: 'x', now: NOW }), true);
  assert.equal(failAndRefund(db, { userId: 'u_free_1', requestId: 'retry-req-1', error: 'x', now: NOW }), false);
  assert.equal(auditQuota(db, 'u_free_1', '2026-11-12').used, 0);
  const r = reserve(db, args);
  assert.equal(r.kind, 'reserved');
  assert.equal(r.kind === 'reserved' && r.attempt, 2);
  const a = auditQuota(db, 'u_free_1', '2026-11-12');
  assert.equal(a.used, 1);
  assert.ok(a.consistent);
});

test('额度满时，失败返还后可以再用一次', () => {
  const db = fresh();
  for (let i = 0; i < 10; i++) reserve(db, { userId: 'u_free_1', requestId: `full-${i}-xxx`, input: 'x', now: NOW, limit: 10 });
  assert.equal(reserve(db, { userId: 'u_free_1', requestId: 'full-11-xxx', input: 'x', now: NOW, limit: 10 }).kind, 'exceeded');
  failAndRefund(db, { userId: 'u_free_1', requestId: 'full-0-xxx', error: 'x', now: NOW });
  assert.equal(reserve(db, { userId: 'u_free_1', requestId: 'full-12-xxx', input: 'x', now: NOW, limit: 10 }).kind, 'reserved');
});

test('按用户时区切天：北京时间 23:59 与次日 00:00 是两天', () => {
  const db = fresh();
  const late = new Date('2026-11-12T23:59:59+08:00');
  const early = new Date('2026-11-13T00:00:00+08:00');
  for (let i = 0; i < 10; i++) reserve(db, { userId: 'u_free_1', requestId: `late-${i}-xxx`, input: 'x', now: late, limit: 10 });
  assert.equal(reserve(db, { userId: 'u_free_1', requestId: 'late-x-xxxx', input: 'x', now: late, limit: 10 }).kind, 'exceeded');
  assert.equal(reserve(db, { userId: 'u_free_1', requestId: 'early-0-xxx', input: 'x', now: early, limit: 10 }).kind, 'reserved');
  assert.equal(auditQuota(db, 'u_free_1', '2026-11-12').used, 10);
  assert.equal(auditQuota(db, 'u_free_1', '2026-11-13').used, 1);
});

test('Pro 用户不计次', () => {
  const db = fresh();
  for (let i = 0; i < 15; i++) {
    const r = reserve(db, { userId: 'u_pro_1', requestId: `pro-${i}-xxxx`, input: 'x', now: NOW, limit: 10 });
    assert.equal(r.kind, 'reserved');
  }
  assert.equal(auditQuota(db, 'u_pro_1', '2026-11-12').used, 0);
});

test('进程崩溃留下的 processing 请求会被清理并返还', () => {
  const db = fresh();
  reserve(db, { userId: 'u_free_1', requestId: 'crash-req-1', input: 'x', now: NOW, limit: 10 });
  assert.equal(sweepStale(db, new Date(NOW.getTime() + 60_000), 5 * 60_000), 0);
  assert.equal(sweepStale(db, new Date(NOW.getTime() + 10 * 60_000), 5 * 60_000), 1);
  assert.equal(auditQuota(db, 'u_free_1', '2026-11-12').used, 0);
});
