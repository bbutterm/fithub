import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

export const prisma = new PrismaClient();

/**
 * Включает row level security на таблице, созданной в рантайме.
 *
 * Миграции Prisma RLS не включают, а Supabase делает это сам только для таблиц,
 * созданных через дашборд. Без RLS таблица читается и правится снаружи через
 * Data API по ключу anon — именно на это ругается security advisor Supabase.
 *
 * Политик намеренно не создаём: приложение подключается владельцем таблиц,
 * а владельца RLS не ограничивает, тогда как остальным ролям без единой
 * политики не достаётся ничего.
 *
 * Вызывать только с именами-литералами: значение подставляется в SQL как есть.
 * Ошибку глушим — если роль окажется не владельцем, запрос упадёт, но ронять
 * из-за этого обработку апдейта нельзя: таблица уже создана и работает.
 */
export async function enableRls(table: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  } catch (err) {
    logger.warn({ err: String(err), table }, "enable RLS failed");
  }
}
