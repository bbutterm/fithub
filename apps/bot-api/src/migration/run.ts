/**
 * Сценарий импорта целиком: проверка файлов → отказ или запись одной транзакцией
 * → повторная сверка счётчиков после коммита.
 *
 * База доступна только через интерфейс ImportDb (db.ts), файлы — только через
 * FileStore, вывод — только через report(). Поэтому весь сценарий, включая
 * отказы, проверяется тестами без Postgres и без файловой системы.
 *
 * Что печатается: имена таблиц и количества строк. Никаких значений полей —
 * ни в обычном выводе, ни в сообщениях об ошибках.
 */

import type { ImportDb, ImportWriter } from "./db.js";
import { coreCounts, loadExportBundle, type ExportBundle, type FileStore } from "./manifest.js";
import { assertExportIntegrity, assertTargetEmpty, importOrder, PreflightError, type TargetState } from "./preflight.js";
import { CORE_TABLES, CORE_TABLE_SPECS, PROCESSED_UPDATE_TABLE } from "./tables.js";

export const EXIT_OK = 0;
/** Проверки не пройдены — база не изменена */
export const EXIT_REFUSED = 1;
/** Данные записаны, но сверка после коммита разошлась — нужно вмешательство */
export const EXIT_VERIFY_FAILED = 2;

export const DEFAULT_BATCH_SIZE = 1000;

export class PostImportVerificationError extends Error {
  constructor(readonly problems: string[]) {
    super(`сверка после коммита не сошлась:\n  - ${problems.join("\n  - ")}`);
    this.name = "PostImportVerificationError";
  }
}

export type Reporter = (line: string) => void;

export type ImportOptions = {
  store: FileStore;
  /** false (по умолчанию) — dry-run: база не открывается вообще */
  apply: boolean;
  /** Открывается только в режиме apply */
  openDb?: () => ImportDb;
  report: Reporter;
  batchSize?: number;
};

export type ImportOutcome = {
  applied: boolean;
  /** Сколько строк насчитано в выгрузке по таблицам */
  counts: Record<string, number>;
  warnings: string[];
};

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function bundleCounts(bundle: ExportBundle): Record<string, number> {
  const counts: Record<string, number> = { ...coreCounts(bundle) };
  const processed = bundle.rows.get(PROCESSED_UPDATE_TABLE);
  if (processed) counts[PROCESSED_UPDATE_TABLE] = processed.length;
  return counts;
}

async function readTargetState(reader: {
  countCoreTable: ImportWriter["countCoreTable"];
  countProcessedUpdate: ImportWriter["countProcessedUpdate"];
}): Promise<TargetState> {
  const core = {} as TargetState["core"];
  for (const table of CORE_TABLES) core[table] = await reader.countCoreTable(table);
  return { core, processedUpdate: await reader.countProcessedUpdate() };
}

/** Запись внутри уже открытой транзакции: порядок зависимостей, затем sequences. */
async function writeBundle(writer: ImportWriter, bundle: ExportBundle, batchSize: number, report: Reporter): Promise<void> {
  // Отказ по непустой базе — до первой вставки, внутри той же транзакции
  assertTargetEmpty(await readTargetState(writer));
  report("целевая база пуста — начинаю перенос");

  for (const table of importOrder(bundle)) {
    const rows = bundle.rows.get(table) ?? [];
    if (table === PROCESSED_UPDATE_TABLE) await writer.ensureProcessedUpdateTable();
    let written = 0;
    for (const batch of chunk(rows, batchSize)) {
      written += await writer.insertRows(table, batch);
    }
    if (written !== rows.length) {
      throw new PreflightError(`${table}: записано ${written} строк из ${rows.length} — транзакция откатывается`);
    }
    report(`${table}: записано ${written}`);
  }

  // Явные id вставлены в обход sequence — иначе следующий insert получит id=1
  for (const table of CORE_TABLES) {
    const serial = CORE_TABLE_SPECS[table].serialColumn;
    if (!serial) continue;
    await writer.resetSequence(table, serial);
  }
  report("sequence-счётчики переставлены на max(id) + 1");
}

/** Сверка после коммита: счётчики базы обязаны совпасть с выгрузкой. */
export function compareCounts(expected: Record<string, number>, actual: TargetState): string[] {
  const problems: string[] = [];
  for (const table of CORE_TABLES) {
    const want = expected[table] ?? 0;
    const got = actual.core[table];
    if (want !== got) problems.push(`${table}: ожидалось ${want}, в базе ${got}`);
  }
  const wantProcessed = expected[PROCESSED_UPDATE_TABLE];
  if (wantProcessed !== undefined) {
    const got = actual.processedUpdate;
    if (got === null) problems.push(`${PROCESSED_UPDATE_TABLE}: таблицы нет, ожидалось ${wantProcessed} строк`);
    else if (got !== wantProcessed) problems.push(`${PROCESSED_UPDATE_TABLE}: ожидалось ${wantProcessed}, в базе ${got}`);
  }
  return problems;
}

export async function runImport(options: ImportOptions): Promise<ImportOutcome> {
  const { store, apply, report } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  report("читаю каталог выгрузки и проверяю манифест, sha256 и типы значений");
  const bundle = await loadExportBundle(store);
  assertExportIntegrity(bundle);
  for (const warning of bundle.warnings) report(`внимание: ${warning}`);

  const counts = bundleCounts(bundle);
  report("проверка прошла, строк в выгрузке:");
  for (const [table, count] of Object.entries(counts)) report(`  ${table}: ${count}`);

  if (!apply) {
    report("режим dry-run: база не открывалась и не изменялась. Для записи запустите с --apply");
    return { applied: false, counts, warnings: bundle.warnings };
  }

  const openDb = options.openDb;
  if (!openDb) throw new PreflightError("в режиме --apply не передан доступ к базе");
  const db = openDb();
  try {
    await db.transaction((writer) => writeBundle(writer, bundle, batchSize, report));
    report("транзакция закоммичена, сверяю счётчики в базе");
    const actual = await db.read(readTargetState);
    const problems = compareCounts(counts, actual);
    if (problems.length > 0) throw new PostImportVerificationError(problems);
    report("счётчики совпали — перенос завершён");
    return { applied: true, counts, warnings: bundle.warnings };
  } finally {
    await db.close();
  }
}

/** Код возврата по типу ошибки: отказ до записи и расхождение после записи различаются. */
export function exitCodeFor(error: unknown): number {
  return error instanceof PostImportVerificationError ? EXIT_VERIFY_FAILED : EXIT_REFUSED;
}
