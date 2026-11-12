import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getUser } from '../src/db.ts';
import { executeTool, newDraft } from '../src/tools.ts';
import { calendarHint, dayKey, parseLocalDateTime } from '../src/time.ts';

const NOW = new Date('2026-11-12T10:00:00+08:00'); // 周四

test('本地时间解析与日期对照', () => {
  assert.equal(parseLocalDateTime('2026-11-18 14:00', 'Asia/Shanghai')?.toISOString(), '2026-11-18T06:00:00.000Z');
  assert.equal(parseLocalDateTime('2026-02-30 14:00', 'Asia/Shanghai'), null);
  assert.equal(parseLocalDateTime('明天下午', 'Asia/Shanghai'), null);
  assert.equal(dayKey(new Date('2026-11-12T16:30:00Z'), 'Asia/Shanghai'), '2026-11-13');
  assert.match(calendarHint(NOW, 'Asia/Shanghai'), /2026-11-18 周三/);
});

test('工具：过去的时间被拒绝，模型可据此修正', () => {
  const db = openDb(':memory:');
  const ctx = { db, user: getUser(db, 'u_free_1')!, now: NOW, draft: newDraft() };
  const bad = executeTool('create_reminder', JSON.stringify({ title: '开会', remind_at: '2023-10-24 15:00' }), ctx);
  assert.equal(bad.ok, false);
  const good = executeTool('create_reminder', JSON.stringify({ title: '开会', remind_at: '2026-11-13 15:00' }), ctx);
  assert.equal(good.ok, true);
  assert.equal(ctx.draft.reminders.length, 1);
  // 同一轮重复调用不会重复创建
  executeTool('create_reminder', JSON.stringify({ title: '开会', remind_at: '2026-11-13 15:00' }), ctx);
  assert.equal(ctx.draft.reminders.length, 1);
});

test('工具：日程默认 1 小时，结束早于开始被拒绝', () => {
  const db = openDb(':memory:');
  const ctx = { db, user: getUser(db, 'u_free_1')!, now: NOW, draft: newDraft() };
  const r = executeTool('create_calendar_event', JSON.stringify({ title: '与张总吃饭', start_at: '2026-11-18 18:00' }), ctx);
  assert.equal(r.ok, true);
  assert.equal(ctx.draft.events[0].end_at, '2026-11-18T11:00:00.000Z');
  const bad = executeTool('create_calendar_event', JSON.stringify({ title: 'x', start_at: '2026-11-18 18:00', end_at: '2026-11-18 17:00' }), ctx);
  assert.equal(bad.ok, false);
});

test('search_history：关键词 + 日期过滤，只查自己的便签', () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO notes (user_id, request_id, input, summary, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('u_free_1', 'h1', '跟张总聊了报价，每台 120 元', '张总报价 120 元/台', '2026-10-15T03:00:00Z');
  ins.run('u_free_1', 'h2', '跟李经理聊了交期', null, '2026-10-20T03:00:00Z');
  ins.run('u_free_2', 'h3', '张总报价 999 元', null, '2026-10-16T03:00:00Z');
  const ctx = { db, user: getUser(db, 'u_free_1')!, now: NOW, draft: newDraft() };
  const r: any = executeTool('search_history', JSON.stringify({ keywords: ['张总', '报价'], from_date: '2026-10-01', to_date: '2026-10-31' }), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.match(r.results[0].original_text, /120/);
  const none: any = executeTool('search_history', JSON.stringify({ keywords: ['张总'], from_date: '2026-11-01' }), ctx);
  assert.equal(none.count, 0);
});
