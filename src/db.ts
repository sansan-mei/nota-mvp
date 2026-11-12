import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  plan      TEXT NOT NULL CHECK (plan IN ('free', 'pro')),
  timezone  TEXT NOT NULL
);

-- 每个用户每个自然日（按用户时区）一行，used 只通过条件 UPDATE 原子增减
CREATE TABLE IF NOT EXISTS daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  day     TEXT NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (user_id, day)
);

-- 一次 AI 处理请求；(user_id, request_id) 是客户端生成的幂等键
CREATE TABLE IF NOT EXISTS requests (
  user_id    TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed')),
  charged    INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 1,
  input      TEXT NOT NULL,
  note_id    INTEGER,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
);

-- 额度流水：+1 扣次，-1 返还。审计用，SUM(delta) 必须等于 daily_usage.used
CREATE TABLE IF NOT EXISTS quota_ledger (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  request_id TEXT NOT NULL,
  delta      INTEGER NOT NULL CHECK (delta IN (1, -1)),
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  input      TEXT NOT NULL,
  summary    TEXT,
  reply      TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);

CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  due_date   TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  remind_at  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  start_at   TEXT NOT NULL,
  end_at     TEXT NOT NULL,
  location   TEXT,
  created_at TEXT NOT NULL
);

-- Agent 每一步（工具调用与结果），用于界面展示和事后排查
CREATE TABLE IF NOT EXISTS agent_steps (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_user_time ON notes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_steps_req ON agent_steps(user_id, request_id, attempt, seq);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, updated_at);
`;

export const DEMO_USERS = [
  { id: 'u_free_1', name: '小明（Free）', plan: 'free', timezone: 'Asia/Shanghai' },
  { id: 'u_free_2', name: '小红（Free）', plan: 'free', timezone: 'Asia/Shanghai' },
  { id: 'u_pro_1', name: '老王（Pro）', plan: 'pro', timezone: 'Asia/Shanghai' },
] as const;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL + busy_timeout：多个进程共用同一个库时，写事务排队而不是直接报 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 10000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO users (id, name, plan, timezone) VALUES (?, ?, ?, ?)');
  for (const u of DEMO_USERS) insert.run(u.id, u.name, u.plan, u.timezone);
  return db;
}

/** 在 BEGIN IMMEDIATE 事务中执行：一开始就拿写锁，避免“先读后写”被其他进程插队。 */
export function immediate<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export type User = { id: string; name: string; plan: 'free' | 'pro'; timezone: string };

export function getUser(db: DB, id: string): User | undefined {
  return db.prepare('SELECT id, name, plan, timezone FROM users WHERE id = ?').get(id) as User | undefined;
}
