/**
 * Реализация ImportDb на Prisma. Единственный модуль импортёра, который вообще
 * подключается к базе, — его подтягивает только CLI и только в режиме --apply.
 *
 * Строка подключения берётся исключительно из окружения (DATABASE_URL читает сам
 * PrismaClient): она не принимается аргументом, не печатается и не логируется.
 *
 * Имена таблиц и колонок в SQL берутся только из белого списка tables.ts —
 * ничего из манифеста или аргументов в SQL не подставляется. Таблицы соседнего
 * продукта B Plus (строчные имена) недостижимы для этого кода.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import type { ImportDb, ImportReader, ImportWriter } from "./db.js";
import {
  CORE_TABLE_SPECS,
  PROCESSED_UPDATE_TABLE,
  assertKnownTable,
  isCoreTable,
  type CoreTable,
  type ImportableTable
} from "./tables.js";
import type { ConvertedRow } from "./values.js";

/** Транзакционный клиент Prisma (тот же набор методов, что и у PrismaClient). */
type Tx = Prisma.TransactionClient;

/** Идентификатор для SQL: только то, что уже прошло белый список. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`недопустимый идентификатор: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/**
 * SQL для setval: имя sequence приходит параметром, и без явного приведения
 * Postgres не может вывести его тип (setval объявлен как setval(regclass, ...)),
 * поэтому запрос падает с «could not determine data type of parameter $1».
 * Идентификаторы таблицы и колонки подставляются в текст — они уже прошли
 * белый список tables.ts и quoteIdent(), извне сюда не попадает ничего.
 */
export function setvalSql(table: CoreTable, column: string): string {
  return `SELECT setval($1::regclass, COALESCE((SELECT MAX(${quoteIdent(column)}) FROM ${quoteIdent(table)}), 0) + 1, false)`;
}

function countCoreTable(tx: Tx, table: CoreTable): Promise<number> {
  switch (table) {
    case "User":
      return tx.user.count();
    case "Profile":
      return tx.profile.count();
    case "Meal":
      return tx.meal.count();
    case "MealItem":
      return tx.mealItem.count();
    case "DailyAdvice":
      return tx.dailyAdvice.count();
    case "Subscription":
      return tx.subscription.count();
    case "UsageCounter":
      return tx.usageCounter.count();
    case "AiUsage":
      return tx.aiUsage.count();
  }
}

async function processedUpdateExists(tx: Tx): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ reg: string | null }>>`SELECT to_regclass('"ProcessedUpdate"')::text AS reg`;
  return Boolean(rows[0]?.reg);
}

async function countProcessedUpdate(tx: Tx): Promise<number | null> {
  if (!(await processedUpdateExists(tx))) return null;
  const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "ProcessedUpdate"`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Json NOT NULL: значение JSON-null приходит из выгрузки как null, а Prisma
 * различает SQL NULL (DbNull) и JSON null (JsonNull) — иначе вставка упадёт.
 */
function forPrisma(table: CoreTable, row: ConvertedRow): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const column of CORE_TABLE_SPECS[table].columns) {
    if (column.kind === "json" && out[column.name] === null) {
      out[column.name] = column.nullable ? Prisma.DbNull : Prisma.JsonNull;
    }
  }
  return out;
}

/**
 * Вставка через модельный API Prisma: типы (BigInt, Date, Json, text[], enum)
 * он раскладывает сам. Приведение типа — единственная точка, где строгая
 * типизация уступает: состав и типы колонок уже проверены convertRow().
 */
async function insertCoreRows(tx: Tx, table: CoreTable, rows: readonly ConvertedRow[]): Promise<number> {
  const data = rows.map((row) => forPrisma(table, row));
  switch (table) {
    case "User":
      return (await tx.user.createMany({ data: data as Prisma.UserCreateManyInput[] })).count;
    case "Profile":
      return (await tx.profile.createMany({ data: data as Prisma.ProfileCreateManyInput[] })).count;
    case "Meal":
      return (await tx.meal.createMany({ data: data as Prisma.MealCreateManyInput[] })).count;
    case "MealItem":
      return (await tx.mealItem.createMany({ data: data as Prisma.MealItemCreateManyInput[] })).count;
    case "DailyAdvice":
      return (await tx.dailyAdvice.createMany({ data: data as Prisma.DailyAdviceCreateManyInput[] })).count;
    case "Subscription":
      return (await tx.subscription.createMany({ data: data as Prisma.SubscriptionCreateManyInput[] })).count;
    case "UsageCounter":
      return (await tx.usageCounter.createMany({ data: data as Prisma.UsageCounterCreateManyInput[] })).count;
    case "AiUsage":
      return (await tx.aiUsage.createMany({ data: data as Prisma.AiUsageCreateManyInput[] })).count;
  }
}

/** ProcessedUpdate вне Prisma: параметризованный INSERT одной пачкой. */
async function insertProcessedUpdates(tx: Tx, rows: readonly ConvertedRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = Prisma.join(
    rows.map((row) => Prisma.sql`(${row["updateId"] as bigint}::bigint, ${row["createdAt"] as Date}::timestamptz)`)
  );
  const affected = await tx.$executeRaw`INSERT INTO "ProcessedUpdate" ("updateId", "createdAt") VALUES ${values}`;
  return affected;
}

/** Экспортируется ради тестов: в них передаётся заглушка вместо транзакции Prisma. */
export function writerFor(tx: Tx): ImportWriter {
  return {
    countCoreTable: (table) => countCoreTable(tx, table),
    countProcessedUpdate: () => countProcessedUpdate(tx),
    ensureProcessedUpdateTable: async () => {
      // тот же DDL, что создаёт таблицу в рантайме webhook-дедупликации
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "ProcessedUpdate" ("updateId" BIGINT PRIMARY KEY, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`
      );
    },
    insertRows: async (table: ImportableTable, rows) => {
      const known = assertKnownTable(table);
      if (known === PROCESSED_UPDATE_TABLE) return insertProcessedUpdates(tx, rows);
      if (!isCoreTable(known)) throw new Error(`нечего писать в таблицу ${known}`);
      return insertCoreRows(tx, known, rows);
    },
    resetSequence: async (table, column) => {
      const known = assertKnownTable(table);
      if (!isCoreTable(known)) throw new Error(`у таблицы ${known} нет sequence`);
      if (CORE_TABLE_SPECS[known].serialColumn !== column) {
        throw new Error(`${known}.${column} — не autoincrement-колонка`);
      }
      const seq = await tx.$queryRaw<Array<{ seq: string | null }>>`
        SELECT pg_get_serial_sequence(${quoteIdent(known)}, ${column}) AS seq`;
      const sequence = seq[0]?.seq;
      if (!sequence) throw new Error(`у ${known}.${column} нет sequence — схема целевой базы не совпадает`);
      // следующий id = max(id) + 1; само имя sequence идёт параметром, а не в текст запроса
      await tx.$executeRawUnsafe(setvalSql(known, column), sequence);
    }
  };
}

export type PrismaImportDbOptions = {
  /** Предел на всю транзакцию импорта, мс */
  transactionTimeoutMs?: number;
};

/**
 * Создаёт адаптер поверх собственного PrismaClient (не общего из ../db.js —
 * продуктовый рантайм этот импортёр не трогает).
 */
export function createPrismaImportDb(options: PrismaImportDbOptions = {}): ImportDb {
  // log не включаем: в запросах — персональные данные и параметры подключения
  const prisma = new PrismaClient();
  const timeout = options.transactionTimeoutMs ?? 30 * 60_000;
  return {
    transaction: (fn) =>
      prisma.$transaction((tx) => fn(writerFor(tx)), { maxWait: 30_000, timeout }),
    read: (fn) => {
      const reader: ImportReader = {
        countCoreTable: (table) => countCoreTable(prisma, table),
        countProcessedUpdate: () => countProcessedUpdate(prisma)
      };
      return fn(reader);
    },
    close: () => prisma.$disconnect()
  };
}
