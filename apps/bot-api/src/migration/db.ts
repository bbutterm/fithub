/**
 * Контракт доступа к базе для импортёра.
 *
 * Сама логика импорта (run.ts) знает только этот интерфейс — в тестах вместо
 * Postgres подставляется адаптер в памяти, поэтому проверять отказы и порядок
 * записи можно без единого подключения к базе.
 *
 * Реализация на Prisma живёт в prismaDb.ts и подключается только из CLI.
 */

import type { CoreTable, ImportableTable } from "./tables.js";
import type { ConvertedRow } from "./values.js";

/** Чтение состояния целевой базы. */
export type ImportReader = {
  countCoreTable: (table: CoreTable) => Promise<number>;
  /** null — таблицы ProcessedUpdate в базе нет (в свежей базе её создаёт миграция) */
  countProcessedUpdate: () => Promise<number | null>;
};

/** Запись внутри одной транзакции. */
export type ImportWriter = ImportReader & {
  /** Страховка для баз без миграции: идемпотентный DDL той же формы, что и в миграции */
  ensureProcessedUpdateTable: () => Promise<void>;
  /** Вставка пачки строк с явными id; возвращает число записанных строк */
  insertRows: (table: ImportableTable, rows: readonly ConvertedRow[]) => Promise<number>;
  /** setval для sequence autoincrement-колонки после вставки явных id */
  resetSequence: (table: CoreTable, column: string) => Promise<void>;
};

export type ImportDb = {
  /** Одна транзакция на весь импорт: либо переносится всё, либо ничего */
  transaction: <T>(fn: (writer: ImportWriter) => Promise<T>) => Promise<T>;
  /** Чтение вне транзакции — сверка счётчиков уже после коммита */
  read: <T>(fn: (reader: ImportReader) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};
