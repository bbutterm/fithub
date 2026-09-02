// Блокировка «1 распознавание на пользователя» через Postgres —
// работает между всеми serverless-инстансами (in-memory Set — нет).
// Таблица создаётся лениво, миграция не нужна.
import { enableRls, prisma } from "../db.js";
import { logger } from "../logger.js";

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "RecognitionLock" ("userId" INTEGER PRIMARY KEY, "lockedAt" TIMESTAMPTZ NOT NULL DEFAULT now())`
  );
  await enableRls("RecognitionLock");
  tableReady = true;
}

/** true — слот получен; false — у пользователя уже идёт распознавание. */
export async function acquireRecognitionLock(userId: number): Promise<boolean> {
  try {
    await ensureTable();
    // Протухшие блокировки (упавшая функция) снимаем через 90 сек
    await prisma.$executeRaw`DELETE FROM "RecognitionLock" WHERE "userId" = ${userId} AND "lockedAt" < now() - interval '90 seconds'`;
    const inserted = await prisma.$executeRaw`INSERT INTO "RecognitionLock" ("userId") VALUES (${userId}) ON CONFLICT DO NOTHING`;
    return inserted > 0;
  } catch (err) {
    logger.warn({ err: String(err), userId }, "lock acquire failed, allowing");
    return true;
  }
}

export async function releaseRecognitionLock(userId: number): Promise<void> {
  try {
    await prisma.$executeRaw`DELETE FROM "RecognitionLock" WHERE "userId" = ${userId}`;
  } catch {
    /* блокировка снимется сама по TTL */
  }
}
