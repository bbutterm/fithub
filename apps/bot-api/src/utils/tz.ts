// Работа с таймзонами без внешних библиотек — через Intl.

/** Смещение таймзоны tz относительно UTC в миллисекундах на момент utcDate. */
export function tzOffsetMs(tz: string, utcDate: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utcDate)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - utcDate.getTime();
}

/** Локальная дата пользователя в формате YYYY-MM-DD. */
export function localDateStr(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Локальное время пользователя в формате HH:MM. */
export function localTimeStr(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}

/** UTC-инстант, соответствующий локальному dateStr + timeStr в таймзоне tz. */
export function zonedTimeToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const naive = new Date(`${dateStr}T${timeStr}:00Z`);
  let offset = tzOffsetMs(tz, naive);
  offset = tzOffsetMs(tz, new Date(naive.getTime() - offset));
  return new Date(naive.getTime() - offset);
}

/** UTC-диапазон [start, end) локальных суток dateStr в таймзоне tz. */
export function zonedDayRangeUtc(dateStr: string, tz: string): { start: Date; end: Date } {
  const start = zonedTimeToUtc(dateStr, "00:00", tz);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

/** Сдвиг локальной даты на n дней: addDays("2026-01-31", 1) === "2026-02-01". */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
