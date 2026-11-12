import type { DB, User } from './db.ts';
import type { ToolSpec } from './llm.ts';
import { formatLocal, parseLocalDate, parseLocalDateTime } from './time.ts';

/**
 * Agent 运行期间产生的副作用先写进草稿，处理成功后与“请求完成”在同一事务里落库。
 * 这样中途失败（超时、模型报错）不会留下半截待办，返还额度后重试也不会重复创建。
 */
export type Draft = {
  summary: string | null;
  todos: { title: string; due_date: string | null }[];
  reminders: { title: string; remind_at: string }[];
  events: { title: string; start_at: string; end_at: string; location: string | null }[];
};

export const newDraft = (): Draft => ({ summary: null, todos: [], reminders: [], events: [] });

export type ToolContext = { db: DB; user: User; now: Date; draft: Draft };
export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

const MAX_ITEMS = 10;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'save_summary',
      description: '保存这条语音便签的一句话摘要。用户在记录事情时调用一次；用户只是提问时不要调用。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '不超过 60 字的中文摘要，保留人名、金额、日期等关键信息' } },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_todo',
      description: '为用户创建一条待办。只创建便签里用户本人需要去做的事。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '以动词开头的简短待办，如“给张总回复报价”' },
          due_date: { type: 'string', description: '截止日期 YYYY-MM-DD（用户本地日期），没有就不传' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: '在指定时间提醒用户。用户明确要求“提醒我”时使用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '提醒内容' },
          remind_at: { type: 'string', description: '提醒时间，用户本地时间，格式 YYYY-MM-DD HH:mm' },
        },
        required: ['title', 'remind_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: '在用户日历里创建一个有具体时间的日程（约会、会议、饭局等）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '日程标题，如“与张总吃饭”' },
          start_at: { type: 'string', description: '开始时间，用户本地时间，格式 YYYY-MM-DD HH:mm' },
          end_at: { type: 'string', description: '结束时间，格式同上；不确定就不传，默认 1 小时' },
          location: { type: 'string', description: '地点，可选' },
        },
        required: ['title', 'start_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_history',
      description: '检索用户过去的语音便签。回答“我之前说过/聊过什么”之类的问题前必须先调用。',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '2–4 个关键词，如人名、主题词（“张总”“报价”），不要整句',
          },
          from_date: { type: 'string', description: '起始日期 YYYY-MM-DD（含），可选' },
          to_date: { type: 'string', description: '结束日期 YYYY-MM-DD（含），可选' },
        },
        required: ['keywords'],
      },
    },
  },
];

function futureOrError(date: Date | null, now: Date, field: string): string | null {
  if (!date) return `${field} 格式应为 YYYY-MM-DD HH:mm`;
  if (date.getTime() <= now.getTime()) return `${field} 已经过去了（当前时间之前），请根据日期对照表重新计算`;
  return null;
}

export function executeTool(name: string, rawArgs: string, ctx: ToolContext): ToolResult {
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: '参数不是合法 JSON' };
  }
  const { draft, user, now } = ctx;
  const tz = user.timezone;
  const totalItems = draft.todos.length + draft.reminders.length + draft.events.length;

  switch (name) {
    case 'save_summary': {
      const summary = str(args.summary, 200);
      if (!summary) return { ok: false, error: 'summary 不能为空' };
      draft.summary = summary;
      return { ok: true, saved: true };
    }
    case 'create_todo': {
      const title = str(args.title, 100);
      if (!title) return { ok: false, error: 'title 不能为空' };
      const due = args.due_date == null || args.due_date === '' ? null : parseLocalDate(args.due_date);
      if (args.due_date && !due) return { ok: false, error: 'due_date 格式应为 YYYY-MM-DD' };
      if (draft.todos.some((t) => t.title === title && t.due_date === due)) return { ok: true, duplicate: true };
      if (totalItems >= MAX_ITEMS) return { ok: false, error: '单条便签最多创建 10 项' };
      draft.todos.push({ title, due_date: due });
      return { ok: true, todo: { title, due_date: due } };
    }
    case 'create_reminder': {
      const title = str(args.title, 100);
      if (!title) return { ok: false, error: 'title 不能为空' };
      const at = parseLocalDateTime(args.remind_at, tz);
      const err = futureOrError(at, now, 'remind_at');
      if (err) return { ok: false, error: err };
      const iso = (at as Date).toISOString();
      if (draft.reminders.some((r) => r.title === title && r.remind_at === iso)) return { ok: true, duplicate: true };
      if (totalItems >= MAX_ITEMS) return { ok: false, error: '单条便签最多创建 10 项' };
      draft.reminders.push({ title, remind_at: iso });
      return { ok: true, reminder: { title, remind_at: formatLocal(at as Date, tz) } };
    }
    case 'create_calendar_event': {
      const title = str(args.title, 100);
      if (!title) return { ok: false, error: 'title 不能为空' };
      const start = parseLocalDateTime(args.start_at, tz);
      const err = futureOrError(start, now, 'start_at');
      if (err) return { ok: false, error: err };
      let end = args.end_at ? parseLocalDateTime(args.end_at, tz) : new Date((start as Date).getTime() + 3600_000);
      if (!end) return { ok: false, error: 'end_at 格式应为 YYYY-MM-DD HH:mm' };
      if (end.getTime() <= (start as Date).getTime()) return { ok: false, error: 'end_at 必须晚于 start_at' };
      const startIso = (start as Date).toISOString();
      if (draft.events.some((e) => e.title === title && e.start_at === startIso)) return { ok: true, duplicate: true };
      if (totalItems >= MAX_ITEMS) return { ok: false, error: '单条便签最多创建 10 项' };
      const location = str(args.location, 100);
      draft.events.push({ title, start_at: startIso, end_at: end.toISOString(), location });
      return { ok: true, event: { title, start_at: formatLocal(start as Date, tz), end_at: formatLocal(end, tz), location } };
    }
    case 'search_history':
      return searchHistory(ctx, args);
    default:
      return { ok: false, error: `未知工具 ${name}` };
  }
}

/**
 * MVP 检索：关键词 LIKE + 时间过滤 + 按命中数排序。
 * 中文短词（如“张总”）用 FTS 分词效果差，千条量级 LIKE 足够；量大后换向量 + 结构化过滤（见 docs）。
 */
function searchHistory(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const keywords = (Array.isArray(args.keywords) ? args.keywords : [args.keywords])
    .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    .map((k) => k.trim().slice(0, 20))
    .slice(0, 6);
  if (keywords.length === 0) return { ok: false, error: 'keywords 不能为空' };
  const from = args.from_date ? parseLocalDate(args.from_date) : null;
  const to = args.to_date ? parseLocalDate(args.to_date) : null;
  if (args.from_date && !from) return { ok: false, error: 'from_date 格式应为 YYYY-MM-DD' };
  if (args.to_date && !to) return { ok: false, error: 'to_date 格式应为 YYYY-MM-DD' };

  const rows = ctx.db
    .prepare('SELECT id, input, summary, created_at FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 2000')
    .all(ctx.user.id) as { id: number; input: string; summary: string | null; created_at: string }[];

  const tz = ctx.user.timezone;
  const hits = rows
    .map((r) => {
      const local = formatLocal(new Date(r.created_at), tz);
      const day = local.slice(0, 10);
      const text = `${r.input}\n${r.summary ?? ''}`;
      const score = keywords.filter((k) => text.includes(k)).length;
      return { r, local, day, score };
    })
    .filter((h) => h.score > 0 && (!from || h.day >= from) && (!to || h.day <= to))
    .sort((a, b) => b.score - a.score || (a.r.created_at < b.r.created_at ? 1 : -1))
    .slice(0, 5);

  return {
    ok: true,
    count: hits.length,
    results: hits.map((h) => ({ note_id: h.r.id, recorded_at: h.local, original_text: h.r.input.slice(0, 500), summary: h.r.summary })),
  };
}
