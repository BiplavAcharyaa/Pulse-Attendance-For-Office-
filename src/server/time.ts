// Timezone-aware helpers. Everything is derived from the host clock + the configured IANA zone.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm:ss
  minutes: number; // minutes since local midnight
  weekday: number; // 0 = Sunday
}

export function localParts(d: Date | number, tz: string): LocalParts {
  const date = typeof d === 'number' ? new Date(d) : d;
  const parts = formatter(tz).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const y = get('year');
  const mo = get('month');
  const da = get('day');
  const h = get('hour');
  const mi = get('minute');
  const s = get('second');
  return {
    date: `${y}-${mo}-${da}`,
    time: `${h}:${mi}:${s}`,
    minutes: Number(h) * 60 + Number(mi),
    weekday: weekdayOf(`${y}-${mo}-${da}`),
  };
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Offset (ms) of `tz` from UTC at the instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const [y, m, d] = p.date.split('-').map(Number);
  const [hh, mm, ss] = p.time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock local date + time in `tz` to a UTC instant (ms). */
export function localToUtcMs(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  return utc;
}

export function parseHHmm(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`Invalid time "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 3700) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid month "${month}"`);
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function formatHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
