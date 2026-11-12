import type { DB, User } from './db.ts';
import { immediate } from './db.ts';
import type { ChatMessage, LLM } from './llm.ts';
import { calendarHint, formatLocal } from './time.ts';
import type { Draft } from './tools.ts';
import { executeTool, newDraft, TOOL_SPECS } from './tools.ts';

export type AgentStep =
  | { kind: 'tool'; seq: number; name: string; args: unknown; result: unknown }
  | { kind: 'reply'; seq: number; content: string };

export type AgentOutput = { draft: Draft; reply: string; steps: AgentStep[] };

const MAX_TURNS = 6;

export function systemPrompt(user: User, now: Date): string {
  const tz = user.timezone;
  return `你是 Nota 的 AI 助理。用户按住硬件按键说话，下面的用户消息是语音转写文本，可能有口语、重复和错别字。

当前时间：${formatLocal(now, tz)}（时区 ${tz}）
未来 14 天日期对照（“本周”指本周一到周日，“下周X”指下一个自然周的周X）：
${calendarHint(now, tz)}

你要做的事：
1. 用户在记录事情：第一步必须调用 save_summary 保存一句话摘要（即使后面还要建日程、提醒）；再把需要用户本人去做的事，逐条用 create_todo 创建；提到了日期的安排（约饭、会议、看电影等，哪怕只说了“晚上”）都用 create_calendar_event 建日程，不要反问；用户明确说“提醒我”时再额外用 create_reminder。不要编造原文没有的事项。
2. 用户在问过去说过的内容（如“上个月跟张总聊的报价是多少”）：必须先调用 search_history，只根据返回的 original_text 回答，并写出是哪天记录的；查不到就直说没找到，绝不编造数字。这类提问不要调用 save_summary。“上个月/上周”指上一个自然月/自然周（如现在是 11 月，上个月就是 10-01 到 10-31）。查到多条相关记录时按时间顺序都列出，并指出最新的是哪条。
3. 时间参数一律用用户本地时间 “YYYY-MM-DD HH:mm”，日期以上面的对照表为准，不要自己推算星期。只说了“上午/中午/下午/晚上”时，分别按 09:00 / 12:00 / 14:00 / 19:00，并在最终回复中说明这是默认时间。“提前一天提醒”= 日程开始时间往前 24 小时。
4. 工具返回 ok:false 时，按错误信息修正参数再调用一次。
5. 全部完成后，用一两句中文告诉用户你做了什么（或回答问题），用纯文本，不要 Markdown 符号，不要输出 JSON。`;
}

export async function runAgent(args: {
  db: DB;
  user: User;
  input: string;
  now: Date;
  llm: LLM;
  onStep?: (step: AgentStep) => void;
}): Promise<AgentOutput> {
  const { db, user, input, now, llm, onStep } = args;
  const draft = newDraft();
  const steps: AgentStep[] = [];
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(user, now) },
    { role: 'user', content: input },
  ];
  const push = (s: AgentStep) => {
    steps.push(s);
    onStep?.(s);
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await llm(messages, TOOL_SPECS);
    if (!msg.tool_calls?.length) {
      const reply = (msg.content ?? '').trim() || '已处理。';
      push({ kind: 'reply', seq: steps.length + 1, content: reply });
      return { draft, reply, steps };
    }
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      const result = executeTool(call.function.name, call.function.arguments, { db, user, now, draft });
      let parsedArgs: unknown = call.function.arguments;
      try {
        parsedArgs = JSON.parse(call.function.arguments);
      } catch {
        /* 保留原始字符串 */
      }
      push({ kind: 'tool', seq: steps.length + 1, name: call.function.name, args: parsedArgs, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error(`Agent 超过 ${MAX_TURNS} 轮仍未结束`);
}

/**
 * 请求完成：便签、待办、提醒、日程与 requests.status=done 在同一事务提交。
 * WHERE status='processing' 保证不会和“超时清理/失败返还”打架。
 */
export function commitResult(
  db: DB,
  args: { user: User; requestId: string; input: string; output: AgentOutput; now: Date },
): number {
  const { user, requestId, input, output, now } = args;
  const ts = now.toISOString();
  return immediate(db, () => {
    const req = db
      .prepare("SELECT status FROM requests WHERE user_id = ? AND request_id = ?")
      .get(user.id, requestId) as { status: string } | undefined;
    if (req?.status !== 'processing') throw new Error(`request 状态为 ${req?.status ?? 'missing'}，放弃提交`);

    const noteId = Number(
      db
        .prepare('INSERT INTO notes (user_id, request_id, input, summary, reply, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, requestId, input, output.draft.summary, output.reply, ts).lastInsertRowid,
    );
    const d = output.draft;
    const t = db.prepare('INSERT INTO todos (user_id, note_id, title, due_date, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const x of d.todos) t.run(user.id, noteId, x.title, x.due_date, ts);
    const r = db.prepare('INSERT INTO reminders (user_id, note_id, title, remind_at, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const x of d.reminders) r.run(user.id, noteId, x.title, x.remind_at, ts);
    const e = db.prepare('INSERT INTO events (user_id, note_id, title, start_at, end_at, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const x of d.events) e.run(user.id, noteId, x.title, x.start_at, x.end_at, x.location, ts);
    db.prepare("UPDATE requests SET status = 'done', note_id = ?, updated_at = ? WHERE user_id = ? AND request_id = ? AND status = 'processing'").run(
      noteId,
      ts,
      user.id,
      requestId,
    );
    return noteId;
  });
}

export function saveSteps(db: DB, userId: string, requestId: string, attempt: number, steps: AgentStep[], now: Date): void {
  const ins = db.prepare(
    'INSERT INTO agent_steps (user_id, request_id, attempt, seq, kind, name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const s of steps) {
    ins.run(userId, requestId, attempt, s.seq, s.kind, s.kind === 'tool' ? s.name : null, JSON.stringify(s), now.toISOString());
  }
}
