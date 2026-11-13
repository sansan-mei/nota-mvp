import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell,
  CalendarPlus,
  CheckCircle2,
  FileText,
  History,
  ListTodo,
  Loader2,
  Mic,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type Audit,
  type CalEvent,
  type Note,
  type Quota,
  type Reminder,
  type Step,
  type StreamEvent,
  type Todo,
  type User,
  deleteItem,
  fetchAudit,
  fetchItems,
  fetchMe,
  fetchNotes,
  fetchUsers,
  getUserId,
  postNote,
  setTodoDone,
  setUserId,
  transcribe,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { useRecorder } from '@/lib/recorder';

const TOOL_META: Record<string, { label: string; icon: typeof FileText }> = {
  save_summary: { label: '保存摘要', icon: FileText },
  create_todo: { label: '创建待办', icon: ListTodo },
  create_reminder: { label: '设置提醒', icon: Bell },
  create_calendar_event: { label: '创建日程', icon: CalendarPlus },
  search_history: { label: '检索历史便签', icon: Search },
};

const EXAMPLES = [
  '下周三下午约张总吃饭，提前一天提醒我',
  '今天跟张总聊了报价，他说每台 120 元，500 台起订，我周五前要给他答复',
  '上个月跟张总聊的那个报价是多少？',
];

type TimelineItem =
  | { id: string; type: 'sys'; text: string; tone?: 'info' | 'ok' | 'warn' | 'error' }
  | { id: string; type: 'tool'; step: Extract<Step, { kind: 'tool' }> };

let uid = 0;
const nextId = () => String(++uid);

/* ------------------------------------------------------------------ */

export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [user, setUser] = useState(getUserId());
  const [quota, setQuota] = useState<Quota | null>(null);
  const [model, setModel] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [reply, setReply] = useState<string | null>(null);
  const [last, setLast] = useState<{ text: string; requestId: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    fetchUsers().then(setUsers);
  }, []);
  useEffect(() => {
    fetchMe().then((me) => {
      setQuota(me.quota);
      setModel(me.model);
    });
  }, [user, refreshKey]);

  const push = (item: TimelineItem) => setTimeline((t) => [...t, item]);

  const handleEvent = (ev: StreamEvent) => {
    switch (ev.type) {
      case 'accepted':
        setQuota(ev.quota);
        push({ id: nextId(), type: 'sys', text: ev.charged ? `已受理，扣除 1 次额度（第 ${ev.attempt} 次尝试）` : '已受理（Pro 不计次）' });
        break;
      case 'step':
        if (ev.step.kind === 'tool') push({ id: nextId(), type: 'tool', step: ev.step });
        else setReply(ev.step.content);
        break;
      case 'done':
        setQuota(ev.quota);
        if (ev.replayed) {
          push({ id: nextId(), type: 'sys', tone: 'ok', text: '这个 requestId 已处理过：直接返回原结果，没有重复扣次' });
          if (ev.note?.reply) setReply(ev.note.reply);
        }
        if (ev.note) {
          const n = ev.note;
          push({
            id: nextId(),
            type: 'sys',
            tone: 'ok',
            text: `已保存便签 #${n.id} · 待办 ${n.todos.length} · 日程 ${n.events.length} · 提醒 ${n.reminders.length}`,
          });
        }
        break;
      case 'error':
        setQuota(ev.quota);
        push({ id: nextId(), type: 'sys', tone: 'error', text: `${ev.message}${ev.refunded ? '，额度已返还' : ''}` });
        break;
      case 'http_error':
        if (ev.quota) setQuota(ev.quota);
        push({ id: nextId(), type: 'sys', tone: 'warn', text: `${ev.message ?? ev.error}（HTTP ${ev.status}）` });
        break;
    }
  };

  const submit = async (content: string, requestId: string) => {
    if (busy) return;
    setBusy(true);
    setLast({ text: content, requestId });
    setTimeline([]);
    setReply(null);
    try {
      await postNote(content, requestId, handleEvent);
    } catch (e) {
      push({ id: nextId(), type: 'sys', tone: 'error', text: `网络错误：${(e as Error).message}。点“重发”用同一个 requestId 重试，不会重复扣次` });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onSend = () => {
    const t = text.trim();
    if (!t) return toast('先说点什么或输入一段话');
    submit(t, crypto.randomUUID());
  };

  const switchUser = (id: string) => {
    setUserId(id);
    setUser(id);
    setTimeline([]);
    setReply(null);
    setLast(null);
  };

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-muted/40">
        <Header users={users} user={user} onUser={switchUser} quota={quota} model={model} />
        <main className="mx-auto grid max-w-6xl gap-4 p-4 md:grid-cols-[1.1fr_1fr] md:p-6">
          <div className="flex min-w-0 flex-col gap-4">
            <Composer
              text={text}
              setText={setText}
              busy={busy}
              canReplay={!!last}
              onSend={onSend}
              onReplay={() => last && submit(last.text, last.requestId)}
            />
            <AgentTimeline timeline={timeline} reply={reply} busy={busy} requestId={last?.requestId} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <Workspace refreshKey={refreshKey} onChange={refresh} />
            <QuotaAudit refreshKey={refreshKey} quota={quota} onDone={refresh} />
          </div>
        </main>
      </div>
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ */

function Header(props: { users: User[]; user: string; onUser: (id: string) => void; quota: Quota | null; model: string }) {
  const { quota } = props;
  const pct = quota?.limit ? (quota.used / quota.limit) * 100 : 0;
  return (
    <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 md:px-6">
        <div className="flex items-center gap-2">
          <motion.div
            className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground"
            animate={{ rotate: [0, -8, 8, 0] }}
            transition={{ duration: 1.2, delay: 0.3 }}
          >
            <Sparkles className="size-4" />
          </motion.div>
          <div className="leading-tight">
            <div className="font-semibold">Nota</div>
            <div className="text-xs text-muted-foreground">AI 语音便签 · MVP</div>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {props.model && (
            <Badge variant="outline" className="hidden sm:inline-flex">
              模型 {props.model}
            </Badge>
          )}
          {quota && (
            <div className="flex w-44 flex-col gap-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">今日额度</span>
                <motion.span key={`${quota.used}-${quota.plan}`} initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="font-medium tabular-nums">
                  {quota.plan === 'pro' ? `Pro 不限 · 已用 ${quota.used}` : `剩余 ${quota.remaining}/${quota.limit}`}
                </motion.span>
              </div>
              <Progress value={quota.plan === 'pro' ? 100 : pct} className={cn('h-1.5', quota.remaining === 0 && '[&>*]:bg-destructive')} />
            </div>
          )}
          <Select value={props.user} onValueChange={props.onUser}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="选择用户" />
            </SelectTrigger>
            <SelectContent>
              {props.users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */

function Composer(props: { text: string; setText: (s: string) => void; busy: boolean; canReplay: boolean; onSend: () => void; onReplay: () => void }) {
  const [transcribing, setTranscribing] = useState(false);
  const textRef = useRef(props.text);
  textRef.current = props.text;

  const recorder = useRecorder(
    async (blob) => {
      setTranscribing(true);
      try {
        const { text, ms } = await transcribe(blob);
        if (!text) return toast.warning('没有识别到内容，请靠近麦克风再说一次');
        const cur = textRef.current.trim();
        props.setText(cur ? `${cur}${/[。！？.!?]$/.test(cur) ? '' : '，'}${text}` : text);
        toast.success(`转写完成（${(ms / 1000).toFixed(1)}s），确认后点发送`);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setTranscribing(false);
      }
    },
    (msg) => toast.warning(msg),
  );
  const recording = recorder.state === 'recording';
  const micDisabled = !recorder.supported || transcribing || props.busy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>说一段话</CardTitle>
        <CardDescription>按住麦克风说话（模拟硬件按键录音，云端千问 ASR 转写），或直接输入；AI 会整理摘要并帮你把事办了</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="relative">
          <Textarea
            rows={4}
            value={props.text}
            onChange={(e) => props.setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onSend();
            }}
            placeholder="例如：下周三下午约张总吃饭，提前一天提醒我"
            className="resize-none pr-2"
          />
          <AnimatePresence>
            {(recording || transcribing || recorder.state === 'starting') && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={cn(
                  'absolute top-2 right-2 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-white',
                  recording ? 'bg-destructive' : 'bg-primary',
                )}
              >
                {recording ? (
                  <>
                    <motion.span className="size-1.5 rounded-full bg-white" animate={{ opacity: [1, 0.2, 1] }} transition={{ repeat: Infinity, duration: 1 }} />
                    录音中 {(recorder.elapsed / 1000).toFixed(1)}s
                  </>
                ) : (
                  <>
                    <Loader2 className="size-3 animate-spin" /> {transcribing ? '云端转写中…' : '打开麦克风…'}
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant={recording ? 'destructive' : 'outline'}
                  disabled={micDisabled}
                  className="touch-none select-none"
                  style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
                  onContextMenu={(e) => e.preventDefault()}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    // 捕获指针：手指移出按钮也不会中断录音，松手才结束
                    e.currentTarget.setPointerCapture(e.pointerId);
                    recorder.start();
                  }}
                  onPointerUp={recorder.stop}
                  onPointerCancel={recorder.stop}
                >
                  {transcribing ? <Loader2 className="animate-spin" /> : <Mic />}
                  {recording ? '松开结束' : '按住说话'}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{recorder.supported ? '按住录音，松开后上传到云端转写（最长 60 秒）' : '当前浏览器不支持录音，请直接输入'}</TooltipContent>
          </Tooltip>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button variant="ghost" disabled={!props.canReplay || props.busy} onClick={props.onReplay}>
                  <RotateCcw /> 重发
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>用上一个 requestId 再发一次，模拟网络重试：不会重复扣次</TooltipContent>
          </Tooltip>
          <Button onClick={props.onSend} disabled={props.busy || transcribing || recording}>
            {props.busy ? <Loader2 className="animate-spin" /> : <Send />} 发送
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <motion.button
              key={ex}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => props.setText(ex)}
              className="rounded-full border bg-background px-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              {ex}
            </motion.button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function AgentTimeline(props: { timeline: TimelineItem[]; reply: string | null; busy: boolean; requestId?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Agent 调用过程
          {props.busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </CardTitle>
        <CardDescription>{props.requestId ? `requestId ${props.requestId.slice(0, 8)}…（幂等键）` : '发送后实时显示模型每一步调用了什么工具'}</CardDescription>
      </CardHeader>
      <CardContent>
        {props.timeline.length === 0 && !props.busy ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有调用记录</div>
        ) : (
          <ol className="relative ml-1 flex list-none flex-col gap-2 border-l pl-4">
            <AnimatePresence initial={false}>
              {props.timeline.map((item) => (
                <motion.li
                  key={item.id}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  className="relative"
                >
                  <span className="absolute top-2.5 -left-[21.5px] size-2.5 rounded-full border-2 border-background bg-primary" />
                  {item.type === 'tool' ? <ToolStep step={item.step} /> : <SysStep item={item} />}
                </motion.li>
              ))}
            </AnimatePresence>
            {props.busy && (
              <motion.li initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> 模型思考中…
              </motion.li>
            )}
          </ol>
        )}
        <AnimatePresence>
          {props.reply && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 rounded-xl bg-primary/5 p-3 text-sm leading-relaxed whitespace-pre-wrap ring-1 ring-primary/15"
            >
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary">
                <Sparkles className="size-3.5" /> Nota 回复
              </div>
              {props.reply}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

function ToolStep({ step }: { step: Extract<Step, { kind: 'tool' }> }) {
  const meta = TOOL_META[step.name] ?? { label: step.name, icon: Zap };
  const Icon = meta.icon;
  const ok = step.result?.ok;
  return (
    <div className={cn('rounded-lg border bg-background p-2.5 text-sm', !ok && 'border-destructive/30 bg-destructive/5')}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-primary" />
        <span className="font-medium">{meta.label}</span>
        <code className="text-xs text-muted-foreground">{step.name}</code>
        <Badge variant={ok ? 'secondary' : 'destructive'} className="ml-auto">
          {ok ? '成功' : '参数被拒，模型将修正'}
        </Badge>
      </div>
      <pre className="mt-2 overflow-x-auto rounded-md bg-muted/60 p-2 text-xs leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
        参数 {JSON.stringify(step.args)}
        {'\n'}结果 {JSON.stringify(step.result)}
      </pre>
    </div>
  );
}

function SysStep({ item }: { item: Extract<TimelineItem, { type: 'sys' }> }) {
  const Icon = item.tone === 'ok' ? CheckCircle2 : item.tone === 'error' || item.tone === 'warn' ? TriangleAlert : ShieldCheck;
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs',
        item.tone === 'ok' && 'bg-emerald-50 text-emerald-700',
        item.tone === 'error' && 'bg-destructive/10 text-destructive',
        item.tone === 'warn' && 'bg-amber-50 text-amber-700',
        (!item.tone || item.tone === 'info') && 'bg-muted text-muted-foreground',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      {item.text}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Workspace({ refreshKey, onChange }: { refreshKey: number; onChange: () => void }) {
  const [items, setItems] = useState<{ todos: Todo[]; reminders: Reminder[]; events: CalEvent[] }>({ todos: [], reminders: [], events: [] });
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    fetchItems().then(setItems);
    fetchNotes().then(setNotes);
  }, [refreshKey]);

  const remove = async (kind: 'todos' | 'reminders' | 'events', id: number) => {
    await deleteItem(kind, id);
    toast.success('已撤销');
    onChange();
  };

  return (
    <Card>
      <CardContent>
        <Tabs defaultValue="todos">
          <TabsList className="w-full">
            <TabsTrigger value="todos">
              <ListTodo /> 待办 <Count n={items.todos.filter((t) => !t.done).length} />
            </TabsTrigger>
            <TabsTrigger value="events">
              <CalendarPlus /> 日程 <Count n={items.events.length} />
            </TabsTrigger>
            <TabsTrigger value="reminders">
              <Bell /> 提醒 <Count n={items.reminders.length} />
            </TabsTrigger>
            <TabsTrigger value="notes">
              <History /> 历史
            </TabsTrigger>
          </TabsList>

          <TabsContent value="todos">
            <List empty="暂无待办">
              {items.todos.map((t) => (
                <Row key={`t${t.id}`} onDelete={() => remove('todos', t.id)}>
                  <Checkbox
                    checked={!!t.done}
                    onCheckedChange={async (v) => {
                      await setTodoDone(t.id, v === true);
                      onChange();
                    }}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-sm', t.done && 'text-muted-foreground line-through')}>{t.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.due_date ? `截止 ${t.due_date}` : '无截止日期'} · 便签 #{t.note_id}
                    </div>
                  </div>
                </Row>
              ))}
            </List>
          </TabsContent>

          <TabsContent value="events">
            <List empty="暂无日程">
              {items.events.map((e) => (
                <Row key={`e${e.id}`} onDelete={() => remove('events', e.id)}>
                  <DateChip text={e.start_local} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{e.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.start_local} – {e.end_local.slice(11)}
                      {e.location ? ` · ${e.location}` : ''}
                    </div>
                  </div>
                </Row>
              ))}
            </List>
          </TabsContent>

          <TabsContent value="reminders">
            <List empty="暂无提醒">
              {items.reminders.map((r) => (
                <Row key={`r${r.id}`} onDelete={() => remove('reminders', r.id)}>
                  <Bell className="mt-0.5 size-4 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{r.title}</div>
                    <div className="text-xs text-muted-foreground">{r.remind_at_local}</div>
                  </div>
                </Row>
              ))}
            </List>
          </TabsContent>

          <TabsContent value="notes">
            <List empty="还没有便签">
              {notes.map((n) => (
                <motion.div key={`n${n.id}`} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-2.5">
                  <div className="text-sm">{n.input}</div>
                  {n.summary && <div className="mt-1 text-xs text-primary">摘要：{n.summary}</div>}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {n.created_local} · 待办 {n.todos.length} · 日程 {n.events.length} · 提醒 {n.reminders.length}
                  </div>
                </motion.div>
              ))}
            </List>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

const Count = ({ n }: { n: number }) =>
  n > 0 ? <span className="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary tabular-nums">{n}</span> : null;

function DateChip({ text }: { text: string }) {
  return (
    <div className="flex w-11 shrink-0 flex-col items-center rounded-lg border bg-background py-1 leading-none">
      <span className="text-[10px] text-muted-foreground">{text.slice(5, 7)}月</span>
      <span className="text-base font-semibold">{text.slice(8, 10)}</span>
      <span className="text-[10px] text-muted-foreground">{text.slice(17)}</span>
    </div>
  );
}

function List({ children, empty }: { children: React.ReactNode; empty: string }) {
  const arr = Array.isArray(children) ? children : [children];
  if (arr.length === 0) return <div className="py-8 text-center text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="max-h-[420px] divide-y overflow-y-auto pr-1">
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </div>
  );
}

function Row({ children, onDelete }: { children: React.ReactNode; onDelete: () => void }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24 }}
      className="group flex items-start gap-3 py-2.5"
    >
      {children}
      <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100" onClick={onDelete} aria-label="撤销">
        <Trash2 />
      </Button>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */

function QuotaAudit({ refreshKey, quota, onDone }: { refreshKey: number; quota: Quota | null; onDone: () => void }) {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [burst, setBurst] = useState<{ ok: number; rejected: number; other: number } | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    fetchAudit().then(setAudit);
  }, [refreshKey]);

  /** 同时发 15 个不同请求，看服务端是否只放行剩余次数（真实调用模型，只会消耗剩余额度）。 */
  const runBurst = async () => {
    if (quota?.plan === 'pro') return toast('Pro 用户不计次，切换到 Free 用户再试');
    setRunning(true);
    setBurst(null);
    const results = await Promise.all(
      Array.from({ length: 15 }, async (_, i) => {
        let status = 'other';
        await postNote(`并发压测第 ${i + 1} 条：记得买牛奶`, crypto.randomUUID(), (ev) => {
          if (ev.type === 'done') status = 'ok';
          else if (ev.type === 'http_error' && ev.status === 429) status = 'rejected';
        }).catch(() => {});
        return status;
      }),
    );
    setBurst({
      ok: results.filter((s) => s === 'ok').length,
      rejected: results.filter((s) => s === 'rejected').length,
      other: results.filter((s) => s === 'other').length,
    });
    setRunning(false);
    onDone();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" /> 额度对账
        </CardTitle>
        <CardDescription>daily_usage、流水合计、已扣次请求三方必须相等</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {audit && (
          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              ['已用', audit.used],
              ['流水合计', audit.ledgerSum],
              ['扣次请求', audit.chargedRequests],
              ['便签', audit.notes],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-muted/60 py-2">
                <motion.div key={`${k}-${v}`} initial={{ scale: 1.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-lg font-semibold tabular-nums">
                  {v}
                </motion.div>
                <div className="text-[11px] text-muted-foreground">{k}</div>
              </div>
            ))}
          </div>
        )}
        {audit && (
          <Badge variant={audit.consistent ? 'secondary' : 'destructive'} className="self-start">
            {audit.consistent ? <CheckCircle2 /> : <TriangleAlert />} {audit.consistent ? '对账一致' : '对账不一致'}
          </Badge>
        )}
        <Separator />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={runBurst} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <Zap />} 同时发 15 个请求
          </Button>
          <AnimatePresence>
            {burst && (
              <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="text-xs text-muted-foreground">
                成功 <b className="text-foreground">{burst.ok}</b> · 拒绝(429) <b className="text-foreground">{burst.rejected}</b>
                {burst.other > 0 && ` · 其他 ${burst.other}`}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <p className="text-xs text-muted-foreground">会真实调用模型，最多消耗剩余额度。完整的多进程压测见 npm run proof:quota。</p>
      </CardContent>
    </Card>
  );
}
