import type { User } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { localDateStr } from "../utils/tz.js";
import { getPlan } from "./subscription.js";

export interface LimitCheck {
  allowed: boolean;
  used: number;
  limit: number | null; // null = безлимит (Pro)
}

/** Персональный лимит из админки важнее общего free-лимита. */
function limitFor(user: User): number {
  return user.dailyLimitOverride ?? config.FREE_PHOTOS_PER_DAY;
}

/**
 * Узнать состояние лимита, ничего не расходуя.
 *
 * Нужен там, где решение принимается заранее, а списывать ещё рано: например,
 * перед платной расшифровкой голосового, которое может оказаться уточнением.
 * Для самого расхода есть tryConsumeRecognition — здесь проверка неатомарна
 * по определению.
 */
export async function checkRecognitionLimit(user: User): Promise<LimitCheck> {
  const plan = await getPlan(user.id);
  if (plan === "pro") return { allowed: true, used: 0, limit: null };
  const date = localDateStr(user.tz);
  const counter = await prisma.usageCounter.findUnique({
    where: { userId_date: { userId: user.id, date } }
  });
  const used = counter?.photoCount ?? 0;
  const limit = limitFor(user);
  return { allowed: used < limit, used, limit };
}

/**
 * Занять одно распознавание. Проверка и списание — один запрос к базе.
 *
 * Раньше это были два шага: «прочитать счётчик, сравнить» и позже «увеличить».
 * Два одновременных сообщения проходили оба, а списание стояло ПОСЛЕ вызова
 * модели — упавшая запись сжигала попытку. Теперь условие живёт внутри UPDATE:
 * строка обновляется, только если счётчик ещё не достиг лимита, и отсутствие
 * результата означает, что лимит исчерпан.
 *
 * Если дальше по коду что-то сорвалось, попытку возвращают через
 * refundRecognition — пользователь не должен платить за нашу ошибку.
 */
export async function tryConsumeRecognition(user: User): Promise<LimitCheck> {
  const plan = await getPlan(user.id);
  if (plan === "pro") return { allowed: true, used: 0, limit: null };

  const limit = limitFor(user);
  // Лимит 0 из админки: вставка всё равно создала бы строку со счётчиком 1
  if (limit <= 0) return { allowed: false, used: 0, limit };

  const date = localDateStr(user.tz);
  const rows = await prisma.$queryRaw<Array<{ photoCount: number }>>`
    INSERT INTO "UsageCounter" ("userId", "date", "photoCount")
    VALUES (${user.id}, ${date}, 1)
    ON CONFLICT ("userId", "date") DO UPDATE
      SET "photoCount" = "UsageCounter"."photoCount" + 1
      WHERE "UsageCounter"."photoCount" < ${limit}
    RETURNING "photoCount"`;

  const used = rows[0]?.photoCount;
  if (used === undefined) {
    // Конфликт был, но условие не выполнилось — счётчик уже на лимите
    return { allowed: false, used: limit, limit };
  }
  return { allowed: true, used, limit };
}

/** Вернуть занятую попытку: распознавание не состоялось не по вине пользователя. */
export async function refundRecognition(user: User): Promise<void> {
  const date = localDateStr(user.tz);
  try {
    await prisma.$executeRaw`
      UPDATE "UsageCounter" SET "photoCount" = "photoCount" - 1
      WHERE "userId" = ${user.id} AND "date" = ${date} AND "photoCount" > 0`;
  } catch (err) {
    // Не критично: пользователь потеряет одну попытку из дневного лимита
    logger.warn({ err: String(err), userId: user.id }, "limit refund failed");
  }
}

/** Анти-спам между инстансами: не более 12 вызовов ИИ за минуту (считаем по AiUsage). */
export async function checkBurstLimit(userId: number): Promise<boolean> {
  const count = await prisma.aiUsage.count({
    where: { userId, createdAt: { gte: new Date(Date.now() - 60_000) } }
  });
  return count < 12;
}
