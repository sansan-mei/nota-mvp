const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

export function partsIn(date: Date, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const m: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) m[p.type] = p.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(m.weekday);
  return { year: +m.year, month: +m.month, day: +m.day, hour: +m.hour, minute: +m.minute, second: +m.second, weekday: wd };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 用户时区下的自然日，作为额度的“天”。 */
export function dayKey(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatLocal(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${WEEKDAYS[p.weekday]}`;
}

function offsetMinutes(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** 把用户时区的本地时间换算成绝对时间。 */
export function localToDate(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - offsetMinutes(new Date(guess), timeZone) * 60000;
  // 夏令时边界再校正一次
  result = guess - offsetMinutes(new Date(result), timeZone) * 60000;
  return new Date(result);
}

/** 解析模型传来的 "YYYY-MM-DD HH:mm"（用户本地时间）。返回 null 表示格式不合法。 */
export function parseLocalDateTime(input: unknown, timeZone: string): Date | null {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = localToDate(y, mo, d, h, mi, timeZone);
  // 拒绝 2 月 30 日这种会被自动进位的日期
  const back = partsIn(date, timeZone);
  if (back.month !== mo || back.day !== d) return null;
  return date;
}

export function parseLocalDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return m[0];
}

/** 给模型一份日期对照表，避免它自己推算“下周三”是哪天。 */
export function calendarHint(now: Date, timeZone: string, days = 14): string {
  const labels = ['今天', '明天', '后天'];
  const lines: string[] = [];
  const today = partsIn(now, timeZone);
  for (let i = 0; i < days; i++) {
    const dt = new Date(Date.UTC(today.year, today.month - 1, today.day + i, 12));
    const label = labels[i] ? `（${labels[i]}）` : '';
    lines.push(`${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${WEEKDAYS[dt.getUTCDay()]}${label}`);
  }
  // 本周/下周的划分以周一为一周开始
  return lines.join('\n');
}
