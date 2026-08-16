// Межинстансовая дедупликация Telegram-вебхуков по update_id через Postgres.
// Таблица ProcessedUpdate живёт в schema.prisma и создаётся миграцией:
// роль приложения работает без прав CREATE, DDL из рантайма не выполняется.
import { prisma } from "../db.js";
import { logger } from "../logger.js";

// Записи старше 2 суток не нужны: Telegram столько не ретраит. Чистим один раз
// на инстанс (как и раньше) — это обычный DELETE, отдельных прав он не требует.
let retentionSweepDone = false;

/** true — такой update_id уже обработан и его нужно пропустить. */
export async function isDuplicateUpdate(updateId: number): Promise<boolean> {
  try {
    if (!retentionSweepDone) {
      await prisma.$executeRaw`DELETE FROM "ProcessedUpdate" WHERE "createdAt" < now() - interval '2 days'`;
      retentionSweepDone = true;
    }
    const inserted = await prisma.$executeRaw`INSERT INTO "ProcessedUpdate" ("updateId") VALUES (${updateId}) ON CONFLICT DO NOTHING`;
    return inserted === 0;
  } catch (err) {
    logger.warn({ err: String(err) }, "update dedupe failed, processing anyway");
    return false;
  }
}
