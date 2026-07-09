// Очередь на пользователя: не более 1 распознавания одновременно + защита от спама фото.

const busyUsers = new Set<number>();

/** Пытается занять слот распознавания. true — можно работать, false — уже идёт распознавание. */
export function tryAcquire(userId: number): boolean {
  if (busyUsers.has(userId)) return false;
  busyUsers.add(userId);
  return true;
}

export function release(userId: number): void {
  busyUsers.delete(userId);
}

// Простой rate limit: не более N запросов распознавания за окно.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const requestLog = new Map<number, number[]>();

export function checkRateLimit(userId: number, now: number = Date.now()): boolean {
  const log = (requestLog.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (log.length >= MAX_PER_WINDOW) {
    requestLog.set(userId, log);
    return false;
  }
  log.push(now);
  requestLog.set(userId, log);
  return true;
}
