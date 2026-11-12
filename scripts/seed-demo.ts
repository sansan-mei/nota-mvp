/**
 * 写入几条“过去的便签”，用于演示基于历史记录回答问题。
 * 直接写库、不经过 Agent，也不占用额度。可重复执行（按 request_id 去重）。
 *
 *   node scripts/seed-demo.ts
 */
import { loadDotEnv, readConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

loadDotEnv();
const db = openDb(readConfig().dbPath);
const DAY = 86400_000;
const now = Date.now();

const notes: { user: string; daysAgo: number; input: string; summary: string }[] = [
  { user: 'u_free_1', daysAgo: 33, input: '刚跟张总通完电话，他那边对 Nota 硬件有兴趣，报价我给的是每台 128 元，500 台起订，含税不含运费，他说要回去跟老板商量。', summary: '张总询价：每台 128 元，500 台起订，含税不含运费' },
  { user: 'u_free_1', daysAgo: 27, input: '张总回电话了，砍价到每台 118 元，但要求起订量降到 300 台，我说要跟财务确认一下再回复。', summary: '张总还价：每台 118 元、起订 300 台，待财务确认' },
  { user: 'u_free_1', daysAgo: 20, input: '周会记录：硬件样机延期一周，测试那边需要再给两天回归时间。', summary: '周会：样机延期一周，测试需多两天回归' },
  { user: 'u_free_1', daysAgo: 6, input: '李经理说下个月展会的展位已经订好了，在 3 号馆，需要我们准备 20 台演示机。', summary: '李经理：展会 3 号馆展位已订，需准备 20 台演示机' },
  { user: 'u_pro_1', daysAgo: 12, input: '王总说年底前要一个定制版本，logo 换成他们的，数量大概 2000 台。', summary: '王总：年底前定制版，换 logo，约 2000 台' },
];

const ins = db.prepare(
  'INSERT OR IGNORE INTO notes (user_id, request_id, input, summary, reply, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
);
let n = 0;
for (const [i, x] of notes.entries()) {
  n += Number(ins.run(x.user, `seed-demo-${i}`, x.input, x.summary, new Date(now - x.daysAgo * DAY).toISOString()).changes);
}
console.log(`写入 ${n} 条演示历史便签（已存在的跳过）`);
