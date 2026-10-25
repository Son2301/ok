/** Injectable clock so the scheduler, billing and tests can control time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to (tests, simulations). */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string | number = Date.now()) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | string | number): void {
    this.t = new Date(d).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar parts of `date` as seen in time zone `tz`. */
export function localParts(date: Date, tz: string): LocalParts {
  let fmt = partsFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
      hourCycle: 'h23',
    });
    partsFormatters.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: String(p.weekday),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of `date` in `tz`. */
export function localDay(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `YYYY-MM` of `date` in `tz`. */
export function localMonth(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** UTC offset of `tz` at `date`, formatted like `+07:00`. */
export function utcOffset(date: Date, tz: string): string {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const minutes = Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Human-readable local date/time, e.g. `Saturday, 2026-10-25 14:03 (Asia/Ho_Chi_Minh, UTC+07:00)`. */
export function describeLocalTime(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.weekday}, ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${tz}, UTC${utcOffset(date, tz)})`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
