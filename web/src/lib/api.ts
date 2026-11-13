export type Quota = { plan: 'free' | 'pro'; day: string; used: number; limit: number | null; remaining: number | null };
export type User = { id: string; name: string; plan: 'free' | 'pro' };
export type Todo = { id: number; note_id: number; title: string; due_date: string | null; done: number };
export type Reminder = { id: number; note_id: number; title: string; remind_at_local: string };
export type CalEvent = { id: number; note_id: number; title: string; start_local: string; end_local: string; location: string | null };
export type Note = {
  id: number;
  request_id: string;
  input: string;
  summary: string | null;
  reply: string | null;
  created_local: string;
  todos: Todo[];
  reminders: Reminder[];
  events: CalEvent[];
};
export type Step =
  | { kind: 'tool'; seq: number; name: string; args: unknown; result: { ok: boolean; [k: string]: unknown } }
  | { kind: 'reply'; seq: number; content: string };
export type Audit = { day: string; used: number; ledgerSum: number; chargedRequests: number; notes: number; consistent: boolean };

export type StreamEvent =
  | { type: 'accepted'; requestId: string; attempt: number; charged: boolean; quota: Quota }
  | { type: 'step'; step: Step }
  | { type: 'done'; replayed: boolean; note: Note | null; quota: Quota }
  | { type: 'error'; message: string; refunded: boolean; quota: Quota }
  | { type: 'http_error'; status: number; error: string; message?: string; quota?: Quota };

let currentUser = localStorage.getItem('nota.user') || 'u_free_1';
export const getUserId = () => currentUser;
export const setUserId = (id: string) => {
  currentUser = id;
  localStorage.setItem('nota.user', id);
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-user-id': currentUser, ...(init.headers ?? {}) },
  });
  return res.json() as Promise<T>;
}

export const fetchUsers = () => fetch('/api/users').then((r) => r.json() as Promise<User[]>);
export const fetchMe = () => api<{ user: User; quota: Quota; model: string }>('/api/me');
export const fetchItems = () => api<{ todos: Todo[]; reminders: Reminder[]; events: CalEvent[] }>('/api/items');
export const fetchNotes = () => api<Note[]>('/api/notes');
export const fetchAudit = () => api<Audit>('/api/quota/audit');
export const setTodoDone = (id: number, done: boolean) => api(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
export const deleteItem = (kind: 'todos' | 'reminders' | 'events', id: number) => api(`/api/${kind}/${id}`, { method: 'DELETE' });

/** 上传录音，返回转写文本（千问 ASR，不占 AI 处理额度）。 */
export async function transcribe(blob: Blob): Promise<{ text: string; ms: number }> {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': blob.type.split(';')[0] || 'audio/webm', 'x-user-id': currentUser },
    body: blob,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

/** 发送一条便签，逐行解析 NDJSON 流。非流式响应（429/409/422）转成 http_error 事件。 */
export async function postNote(text: string, requestId: string, onEvent: (e: StreamEvent) => void): Promise<void> {
  const res = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': currentUser },
    body: JSON.stringify({ requestId, text }),
  });
  if (!res.headers.get('content-type')?.includes('ndjson')) {
    const body = await res.json();
    onEvent({ type: 'http_error', status: res.status, ...body });
    return;
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as StreamEvent);
    }
  }
}
