/**
 * Чтение и проверка каталога выгрузки ДО единой записи в базу.
 *
 * Ожидаемая раскладка каталога (её задаёт мост api/migrationExport.ts):
 *   manifest.json   — { counts: { <Таблица>: number | null }, files: {...} | [...] }
 *   <Таблица>.json  — { rows: [...], count?, table?, nextCursor?, available? }
 *
 * Манифест допускает несколько равнозначных написаний ключей (counts|tables,
 * file|path|name, sha256|checksum, rows|count) и две формы files — карту
 * «таблица → описание» (так пишет мост сейчас) и список описаний — выгрузку делал
 * одноразовый скрипт, и жёсткая привязка к одному написанию ломала бы импорт на ровном месте.
 * Всё остальное строго: неизвестная таблица, нехватка sha256, расхождение
 * счётчиков и незакрытая пагинация (nextCursor) — это отказ, а не предупреждение.
 */

import { createHash } from "node:crypto";
import {
  CORE_TABLES,
  NOT_MIGRATED_TABLES,
  PROCESSED_UPDATE_TABLE,
  assertKnownTable,
  specOf,
  type CoreTable,
  type ImportableTable
} from "./tables.js";
import { convertRows, type ConvertedRow } from "./values.js";

export const MANIFEST_FILE = "manifest.json";

/** Доступ к файлам каталога выгрузки; в тестах подменяется картой в памяти. */
export type FileStore = {
  /** Имена файлов в каталоге (без путей). */
  list: () => Promise<string[]>;
  /** Содержимое файла как есть: sha256 считается по байтам, а не по разобранному JSON. */
  read: (name: string) => Promise<Uint8Array>;
};

export class ExportVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportVerificationError";
  }
}

export type TableFileInfo = {
  table: ImportableTable;
  file: string;
  /** sha256 из манифеста, hex в нижнем регистре */
  sha256: string;
  /** Ожидаемое число строк (из manifest.counts) */
  expectedRows: number;
};

export type ExportBundle = {
  /** Счётчики из манифеста: null — таблицы не было в источнике (ленивый ProcessedUpdate) */
  counts: Record<string, number | null>;
  files: TableFileInfo[];
  /** Готовые к записи строки по таблицам, порядок колонок и типы уже восстановлены */
  rows: Map<ImportableTable, ConvertedRow[]>;
  /** ProcessedUpdate есть в выгрузке и его нужно переносить */
  hasProcessedUpdate: boolean;
  /** Некритичные замечания — печатаются, но не останавливают импорт */
  warnings: string[];
};

/** sha256 по байтам файла. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Имя файла из манифеста не должно уводить за пределы каталога выгрузки. */
export function assertSafeFileName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new ExportVerificationError(`недопустимое имя файла в манифесте: ${JSON.stringify(name)}`);
  }
  return name;
}

function parseJson(name: string, bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExportVerificationError(`${name}: файл не в UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // текст ошибки JSON.parse может содержать фрагмент данных — не пробрасываем
    throw new ExportVerificationError(`${name}: файл не разбирается как JSON`);
  }
}

function asObject(name: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExportVerificationError(`${name}: ожидался JSON-объект`);
  }
  return value as Record<string, unknown>;
}

function pickAlias(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) return source[key];
  }
  return undefined;
}

function asRowCount(what: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ExportVerificationError(`${what}: количество строк должно быть целым числом >= 0`);
  }
  return value;
}

/** Счётчики манифеста: число, либо null для таблицы, которой не было в источнике. */
export function parseCounts(manifest: Record<string, unknown>): Record<string, number | null> {
  const raw = pickAlias(manifest, ["counts", "tables"]);
  const source = asObject(`${MANIFEST_FILE}.counts`, raw);
  const out: Record<string, number | null> = {};
  for (const [table, value] of Object.entries(source)) {
    assertKnownTable(table);
    out[table] = value === null ? null : asRowCount(`${MANIFEST_FILE}.counts.${table}`, value);
  }
  for (const table of CORE_TABLES) {
    if (!(table in out)) throw new ExportVerificationError(`${MANIFEST_FILE}: нет счётчика для таблицы ${table}`);
    if (out[table] === null) {
      throw new ExportVerificationError(`${MANIFEST_FILE}: счётчик таблицы ядра ${table} равен null`);
    }
  }
  return out;
}

/** Описания файлов таблиц: список объектов либо карта «таблица → описание». */
export function parseFileEntries(
  manifest: Record<string, unknown>,
  counts: Record<string, number | null>
): TableFileInfo[] {
  const raw = pickAlias(manifest, ["files", "artifacts"]);
  if (raw === undefined) throw new ExportVerificationError(`${MANIFEST_FILE}: нет списка файлов`);

  // В карте ключ уже называет таблицу, поэтому имя файла в записи необязательно:
  // реальная выгрузка пишет {"User": {"rows": 15, "sha256": "..."}} и кладёт данные
  // в <Таблица>.json. В списке же имя файла — единственная связь с каталогом, и его
  // отсутствие остаётся отказом.
  const entries: Array<{ table: string; entry: Record<string, unknown>; defaultFile?: string }> = [];
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      const entry = asObject(`${MANIFEST_FILE}.files[${index}]`, item);
      const table = pickAlias(entry, ["table", "model"]);
      if (typeof table !== "string") {
        throw new ExportVerificationError(`${MANIFEST_FILE}.files[${index}]: не указана таблица`);
      }
      entries.push({ table, entry });
    });
  } else {
    for (const [table, item] of Object.entries(asObject(`${MANIFEST_FILE}.files`, raw))) {
      entries.push({ table, entry: asObject(`${MANIFEST_FILE}.files.${table}`, item), defaultFile: `${table}.json` });
    }
  }

  const seen = new Set<string>();
  const out: TableFileInfo[] = [];
  for (const { table: tableName, entry, defaultFile } of entries) {
    const table = assertKnownTable(tableName);
    if (seen.has(table)) throw new ExportVerificationError(`${MANIFEST_FILE}: таблица ${table} описана дважды`);
    seen.add(table);

    const declaredFile = pickAlias(entry, ["file", "path", "name"]);
    const file = declaredFile === undefined ? defaultFile : declaredFile;
    if (typeof file !== "string") throw new ExportVerificationError(`${MANIFEST_FILE}.files.${table}: нет имени файла`);
    const sha256 = pickAlias(entry, ["sha256", "checksum", "sha256sum"]);
    if (typeof sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      throw new ExportVerificationError(`${MANIFEST_FILE}.files.${table}: нет корректного sha256`);
    }
    const rowsValue = pickAlias(entry, ["rows", "count", "rowCount"]);
    const expectedFromCounts = counts[table];
    const expectedRows =
      rowsValue === undefined
        ? expectedFromCounts ?? 0
        : asRowCount(`${MANIFEST_FILE}.files.${table}.rows`, rowsValue);
    if (expectedFromCounts !== null && expectedFromCounts !== undefined && expectedFromCounts !== expectedRows) {
      throw new ExportVerificationError(
        `${MANIFEST_FILE}: у таблицы ${table} counts=${expectedFromCounts}, а в описании файла ${expectedRows}`
      );
    }
    out.push({ table, file: assertSafeFileName(file), sha256: sha256.toLowerCase(), expectedRows });
  }
  return out;
}

/** Разбор файла таблицы: конверт {rows,...} проверяется на полноту выгрузки. */
export function parseTableFile(info: TableFileInfo, bytes: Uint8Array): unknown[] {
  const actual = sha256Hex(bytes);
  if (actual !== info.sha256) {
    throw new ExportVerificationError(`${info.file}: sha256 не совпал с манифестом (файл повреждён или подменён)`);
  }
  const body = asObject(info.file, parseJson(info.file, bytes));

  const table = pickAlias(body, ["table", "model"]);
  if (typeof table === "string" && table !== info.table) {
    throw new ExportVerificationError(`${info.file}: внутри файла таблица ${JSON.stringify(table)}, ожидалась ${info.table}`);
  }
  const nextCursor = body["nextCursor"];
  if (nextCursor !== undefined && nextCursor !== null) {
    throw new ExportVerificationError(`${info.file}: выгрузка не дочитана до конца (остался nextCursor)`);
  }
  const rows = body["rows"];
  if (!Array.isArray(rows)) throw new ExportVerificationError(`${info.file}: поле rows должно быть массивом`);

  const declared = pickAlias(body, ["count", "rowCount"]);
  if (declared !== undefined && declared !== rows.length) {
    throw new ExportVerificationError(`${info.file}: count внутри файла не совпадает с длиной rows`);
  }
  if (rows.length !== info.expectedRows) {
    throw new ExportVerificationError(
      `${info.file}: строк ${rows.length}, а манифест обещает ${info.expectedRows}`
    );
  }
  return rows;
}

/**
 * Полная проверка каталога: манифест, контрольные суммы, счётчики и типы значений.
 * Ни одна из этих проверок не обращается к базе — это то, что делает dry-run.
 */
export async function loadExportBundle(store: FileStore): Promise<ExportBundle> {
  const names = await store.list();
  if (!names.includes(MANIFEST_FILE)) {
    throw new ExportVerificationError(`в каталоге выгрузки нет ${MANIFEST_FILE}`);
  }
  const manifest = asObject(MANIFEST_FILE, parseJson(MANIFEST_FILE, await store.read(MANIFEST_FILE)));
  const counts = parseCounts(manifest);
  const files = parseFileEntries(manifest, counts);
  const warnings: string[] = [];

  const byTable = new Map(files.map((f) => [f.table, f]));
  for (const table of CORE_TABLES) {
    const info = byTable.get(table);
    if (!info) {
      if ((counts[table] ?? 0) > 0) {
        throw new ExportVerificationError(`${MANIFEST_FILE}: нет файла для непустой таблицы ${table}`);
      }
      warnings.push(`таблица ${table} пуста и файла в выгрузке нет — перенос пропускает её`);
    }
  }

  const processed = byTable.get(PROCESSED_UPDATE_TABLE);
  const processedCount = counts[PROCESSED_UPDATE_TABLE];
  if (processed && processedCount === null) {
    throw new ExportVerificationError(
      `${MANIFEST_FILE}: для ${PROCESSED_UPDATE_TABLE} есть файл, но counts=null (противоречие)`
    );
  }

  const known = new Set<string>([MANIFEST_FILE, ...files.map((f) => f.file)]);
  for (const name of names) {
    if (known.has(name)) continue;
    const notMigrated = NOT_MIGRATED_TABLES.find((t) => name === `${t}.json`);
    warnings.push(
      notMigrated
        ? `файл ${name} игнорируется: ${notMigrated} не переносится (эфемерные блокировки)`
        : `файл ${name} не упомянут в манифесте и игнорируется`
    );
  }

  const rows = new Map<ImportableTable, ConvertedRow[]>();
  for (const info of files) {
    const raw = parseTableFile(info, await store.read(info.file));
    rows.set(info.table, convertRows(info.table, specOf(info.table), raw));
  }

  return { counts, files, rows, hasProcessedUpdate: Boolean(processed), warnings };
}

/** Счётчики только по таблицам ядра — для сверки с базой после коммита. */
export function coreCounts(bundle: ExportBundle): Record<CoreTable, number> {
  const out = {} as Record<CoreTable, number>;
  for (const table of CORE_TABLES) out[table] = bundle.rows.get(table)?.length ?? 0;
  return out;
}
