/**
 * Восстановление типов из JSON-выгрузки.
 *
 * Мост выгрузки (api/migrationExport.ts, serializeExportValue) кладёт в JSON:
 * BigInt → строка, Date → ISO-строка, Json/массивы → рекурсивно как есть.
 * Здесь обратное преобразование по описанию колонок из tables.ts.
 *
 * Правило про секретность данных: сообщения об ошибках называют таблицу, номер
 * строки, колонку и ожидаемый тип — но НИКОГДА не печатают само значение.
 * В выгрузке персональные данные, они не должны утечь ни в консоль, ни в лог.
 */

import type { ColumnSpec, TableSpec } from "./tables.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Значение, готовое к записи: ровно то, что принимает Prisma/pg-драйвер. */
export type DbValue = string | number | bigint | boolean | Date | string[] | JsonValue | null;

export type ConvertedRow = Record<string, DbValue>;

export class RowConversionError extends Error {
  constructor(
    readonly table: string,
    readonly rowIndex: number,
    readonly column: string,
    readonly problem: string
  ) {
    super(`${table}[строка ${rowIndex}].${column}: ${problem}`);
    this.name = "RowConversionError";
  }
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;
const INTEGER_STRING_RE = /^-?\d{1,19}$/;
const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** Имя типа для сообщения об ошибке — только тип, без содержимого. */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "массив";
  return typeof value;
}

/** Дата существует в календаре: 2026-02-30 не пройдёт. */
export function isRealCalendarDate(text: string): boolean {
  if (!DATE_ONLY_RE.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
  if (t === "object") return Object.values(value as Record<string, unknown>).every((v) => isJsonValue(v, depth + 1));
  return false;
}

function fail(column: ColumnSpec, problem: string): never {
  // Контекст (таблица/строка) добавляет convertRow — здесь только суть претензии
  throw new ColumnProblem(column.name, problem);
}

/** Внутренняя ошибка колонки; convertRow оборачивает её в RowConversionError. */
class ColumnProblem extends Error {
  constructor(
    readonly column: string,
    readonly problem: string
  ) {
    super(problem);
  }
}

/** Конвертация одного значения по типу колонки. Значение в ошибки не попадает. */
export function convertValue(column: ColumnSpec, raw: unknown): DbValue {
  if (raw === null || raw === undefined) {
    // Json NOT NULL может законно хранить JSON-значение null: Prisma отдаёт его
    // в выгрузку как null, и это не SQL NULL. Разбор такой колонки — в адаптере БД.
    if (column.kind === "json" && raw === null) return null;
    if (!column.nullable) fail(column, "значение отсутствует, а колонка NOT NULL");
    return null;
  }

  switch (column.kind) {
    case "int": {
      const n = typeof raw === "string" && INTEGER_STRING_RE.test(raw) ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) fail(column, `ожидалось целое число, получено ${typeName(raw)}`);
      if (!Number.isInteger(n)) fail(column, "ожидалось целое число, получено дробное");
      if (n < INT32_MIN || n > INT32_MAX) fail(column, "целое не помещается в int4");
      return n;
    }
    case "bigint": {
      // мост отдаёт BigInt строкой; число тоже принимаем, если оно точное
      let big: bigint;
      if (typeof raw === "string") {
        if (!INTEGER_STRING_RE.test(raw)) fail(column, "ожидалась строка с целым числом BigInt");
        big = BigInt(raw);
      } else if (typeof raw === "number") {
        if (!Number.isSafeInteger(raw)) fail(column, "число не является точным целым (нужна строка)");
        big = BigInt(raw);
      } else {
        fail(column, `ожидался BigInt строкой, получено ${typeName(raw)}`);
      }
      if (big < INT64_MIN || big > INT64_MAX) fail(column, "число не помещается в int8");
      return big;
    }
    case "float": {
      const n = typeof raw === "string" && DECIMAL_STRING_RE.test(raw) ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) fail(column, `ожидалось число, получено ${typeName(raw)}`);
      return n;
    }
    case "decimal": {
      // Decimal переносим строкой: через number терялась бы точность.
      // (В текущей schema.prisma Decimal-колонок нет — поддержка на случай их появления.)
      if (typeof raw === "number") {
        if (!Number.isFinite(raw)) fail(column, "ожидалось конечное число");
        return String(raw);
      }
      if (typeof raw !== "string" || !DECIMAL_STRING_RE.test(raw)) {
        fail(column, `ожидалась десятичная строка, получено ${typeName(raw)}`);
      }
      return raw;
    }
    case "bool": {
      if (typeof raw !== "boolean") fail(column, `ожидалось true/false, получено ${typeName(raw)}`);
      return raw;
    }
    case "string": {
      if (typeof raw !== "string") fail(column, `ожидалась строка, получено ${typeName(raw)}`);
      return raw;
    }
    case "stringArray": {
      if (!Array.isArray(raw)) fail(column, `ожидался массив строк, получено ${typeName(raw)}`);
      if (!raw.every((v) => typeof v === "string")) fail(column, "в массиве есть элемент не-строка");
      return [...(raw as string[])];
    }
    case "dateTime": {
      if (typeof raw !== "string") fail(column, `ожидалась ISO-дата строкой, получено ${typeName(raw)}`);
      if (!DATE_TIME_RE.test(raw)) fail(column, "строка не похожа на ISO-8601 дату-время");
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) fail(column, "дата не разбирается");
      return date;
    }
    case "dateOnly": {
      // В схеме это text (локальная дата пользователя), формат обязан быть YYYY-MM-DD
      if (typeof raw !== "string") fail(column, `ожидалась дата YYYY-MM-DD строкой, получено ${typeName(raw)}`);
      if (!isRealCalendarDate(raw)) fail(column, "дата не в формате YYYY-MM-DD или не существует в календаре");
      return raw;
    }
    case "json": {
      if (!isJsonValue(raw)) fail(column, "значение не является корректным JSON");
      return raw;
    }
    case "enum": {
      if (typeof raw !== "string") fail(column, `ожидалось значение enum строкой, получено ${typeName(raw)}`);
      if (!column.enumValues?.includes(raw)) fail(column, "значение вне допустимых значений enum");
      return raw;
    }
  }
}

/**
 * Конвертация строки целиком: состав колонок проверяется строго.
 * Лишняя колонка — признак расхождения выгрузки и схемы, это отказ, а не warning.
 */
export function convertRow(
  table: string,
  spec: TableSpec,
  raw: unknown,
  rowIndex: number
): ConvertedRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RowConversionError(table, rowIndex, "<строка>", `ожидался объект, получено ${typeName(raw)}`);
  }
  const source = raw as Record<string, unknown>;
  const known = new Set(spec.columns.map((c) => c.name));
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      throw new RowConversionError(table, rowIndex, key, "колонки нет в схеме FitHub (выгрузка не соответствует схеме)");
    }
  }

  const out: ConvertedRow = {};
  for (const column of spec.columns) {
    const present = Object.prototype.hasOwnProperty.call(source, column.name);
    if (!present && !column.nullable) {
      throw new RowConversionError(table, rowIndex, column.name, "колонка отсутствует в строке выгрузки");
    }
    try {
      out[column.name] = convertValue(column, present ? source[column.name] : null);
    } catch (err) {
      if (err instanceof ColumnProblem) throw new RowConversionError(table, rowIndex, err.column, err.problem);
      throw err;
    }
  }
  return out;
}

export function convertRows(table: string, spec: TableSpec, rows: readonly unknown[]): ConvertedRow[] {
  return rows.map((row, index) => convertRow(table, spec, row, index));
}
