import type { DB, User } from './db.ts';
import { getUser, immediate } from './db.ts';
import { dayKey } from './time.ts';

export type QuotaView = {
  plan: 'free' | 'pro';
  day: string;
  used: number;
  limit: number | null;
  remaining: number | null;
};

export type ReserveResult =
  | { kind: 'reserved'; attempt: number; day: string; charged: boolean }
  | { kind: 'duplicate_done'; noteId: number }
  | { kind: 'duplicate_processing' }
  | { kind: 'conflict' }
  | { kind: 'exceeded'; quota: QuotaView };

const nowIso = (now: Date) => now.toISOString();

export function quotaView(db: DB, user: User, now: Date, limit: number): QuotaView {
  const day = dayKey(now, user.timezone);
  const row = db.prepare('SELECT used FROM daily_usage WHERE user_id = ? AND day = ?').get(user.id, day) as
    | { used: number }
    | undefined;
  const used = row?.used ?? 0;
  if (user.plan === 'pro') return { plan: 'pro', day, used, limit: null, remaining: null };
  return { plan: 'free', day, used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * 预占一次额度并登记请求。整个过程在一个 BEGIN IMMEDIATE 事务里：
 * 1. 同一个幂等键已完成 → 直接返回原结果，不扣次
 * 2. 同一个幂等键正在处理 → 告诉客户端稍后再来，不扣次
 * 3. 新请求 / 上次失败的重试 → 条件 UPDATE 扣次（used < limit 才成功），影响 0 行即额度用尽
 */
export function reserve(
  db: DB,
  args: { userId: string; requestId: string; input: string; now: Date; limit: number },
): ReserveResult {
  const user = getUser(db, args.userId);
  if (!user) throw new Error(`unknown user ${args.userId}`);
  const day = dayKey(args.now, user.timezone);
  const ts = nowIso(args.now);

  return immediate(db, (): ReserveResult => {
    const existing = db
      .prepare('SELECT status, note_id, input, attempts FROM requests WHERE user_id = ? AND request_id = ?')
      .get(user.id, args.requestId) as { status: string; note_id: number | null; input: string; attempts: number } | undefined;

    if (existing && existing.input !== args.input) return { kind: 'conflict' };
    if (existing?.status === 'done') return { kind: 'duplicate_done', noteId: existing.note_id as number };
    if (existing?.status === 'processing') return { kind: 'duplicate_processing' };

    const metered = user.plan === 'free';
    if (metered) {
      db.prepare('INSERT INTO daily_usage (user_id, day, used) VALUES (?, ?, 0) ON CONFLICT DO NOTHING').run(user.id, day);
      const r = db
        .prepare('UPDATE daily_usage SET used = used + 1 WHERE user_id = ? AND day = ? AND used < ?')
        .run(user.id, day, args.limit);
      if (r.changes === 0) {
        // 没扣成功，事务里也没有其他写入，正常提交即可
        return { kind: 'exceeded', quota: quotaView(db, user, args.now, args.limit) };
      }
      db.prepare(
        'INSERT INTO quota_ledger (user_id, day, request_id, delta, reason, created_at) VALUES (?, ?, ?, 1, ?, ?)',
      ).run(user.id, day, args.requestId, existing ? 'charge_retry' : 'charge', ts);
    }

    if (existing) {
      db.prepare(
        `UPDATE requests SET status = 'processing', day = ?, charged = ?, attempts = attempts + 1, error = NULL, updated_at = ?
         WHERE user_id = ? AND request_id = ?`,
      ).run(day, metered ? 1 : 0, ts, user.id, args.requestId);
      return { kind: 'reserved', attempt: existing.attempts + 1, day, charged: metered };
    }
    db.prepare(
      `INSERT INTO requests (user_id, request_id, day, status, charged, attempts, input, created_at, updated_at)
       VALUES (?, ?, ?, 'processing', ?, 1, ?, ?, ?)`,
    ).run(user.id, args.requestId, day, metered ? 1 : 0, args.input, ts, ts);
    return { kind: 'reserved', attempt: 1, day, charged: metered };
  });
}

/**
 * 处理失败：把请求标为 failed 并返还额度。
 * 只有 processing → failed 这一次状态迁移会返还，重复调用不会多返。
 */
export function failAndRefund(db: DB, args: { userId: string; requestId: string; error: string; now: Date }): boolean {
  return immediate(db, () => {
    const req = db
      .prepare('SELECT status, charged, day FROM requests WHERE user_id = ? AND request_id = ?')
      .get(args.userId, args.requestId) as { status: string; charged: number; day: string } | undefined;
    if (!req || req.status !== 'processing') return false;
    db.prepare(
      `UPDATE requests SET status = 'failed', error = ?, charged = 0, updated_at = ? WHERE user_id = ? AND request_id = ? AND status = 'processing'`,
    ).run(args.error.slice(0, 500), nowIso(args.now), args.userId, args.requestId);
    if (req.charged) {
      db.prepare('UPDATE daily_usage SET used = used - 1 WHERE user_id = ? AND day = ? AND used > 0').run(args.userId, req.day);
      db.prepare(
        'INSERT INTO quota_ledger (user_id, day, request_id, delta, reason, created_at) VALUES (?, ?, ?, -1, ?, ?)',
      ).run(args.userId, req.day, args.requestId, 'refund', nowIso(args.now));
    }
    return true;
  });
}

/** 进程崩溃会留下 processing 状态的请求：启动时把超时的标记失败并返还。 */
export function sweepStale(db: DB, now: Date, staleMs: number): number {
  const cutoff = new Date(now.getTime() - staleMs).toISOString();
  const rows = db
    .prepare("SELECT user_id, request_id FROM requests WHERE status = 'processing' AND updated_at < ?")
    .all(cutoff) as { user_id: string; request_id: string }[];
  let n = 0;
  for (const r of rows) {
    if (failAndRefund(db, { userId: r.user_id, requestId: r.request_id, error: 'stale: worker lost', now })) n++;
  }
  return n;
}

/** 审计：daily_usage 与流水、请求表三方对账。 */
export function auditQuota(db: DB, userId: string, day: string) {
  const used = (db.prepare('SELECT used FROM daily_usage WHERE user_id = ? AND day = ?').get(userId, day) as { used: number } | undefined)
    ?.used ?? 0;
  const ledgerSum = (db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM quota_ledger WHERE user_id = ? AND day = ?')
    .get(userId, day) as { s: number }).s;
  const chargedRequests = (db
    .prepare("SELECT COUNT(*) AS c FROM requests WHERE user_id = ? AND day = ? AND charged = 1 AND status IN ('processing', 'done')")
    .get(userId, day) as { c: number }).c;
  const notes = (db.prepare('SELECT COUNT(*) AS c FROM notes n JOIN requests r ON r.user_id = n.user_id AND r.request_id = n.request_id WHERE n.user_id = ? AND r.day = ?').get(userId, day) as { c: number }).c;
  return { used, ledgerSum, chargedRequests, notes, consistent: used === ledgerSum && used === chargedRequests };
}
