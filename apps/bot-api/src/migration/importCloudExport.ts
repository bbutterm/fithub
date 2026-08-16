/**
 * Разовый импорт cloud-выгрузки FitHub в self-hosted Postgres.
 *
 * Запуск:
 *   pnpm --filter bot-api migrate:import <каталог-выгрузки>            # dry-run, база не трогается
 *   pnpm --filter bot-api migrate:import <каталог-выгрузки> --apply    # запись одной транзакцией
 *
 * Правила:
 *  - каталог выгрузки — только аргумент командной строки;
 *  - строка подключения — только переменная окружения DATABASE_URL, её значение
 *    никогда не печатается и не логируется (в аргументах она запрещена);
 *  - без --apply не выполняется ни одного запроса к базе;
 *  - вывод содержит только имена таблиц и количества строк — данные не печатаются.
 *
 * Инструмент одноразовый: после переезда его вместе с мостом выгрузки удаляют.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImportDb } from "./db.js";
import type { FileStore } from "./manifest.js";
import { EXIT_OK, EXIT_REFUSED, exitCodeFor, runImport, type Reporter } from "./run.js";

export type CliOptions = {
  dir: string;
  apply: boolean;
  batchSize?: number;
};

export class CliError extends Error {}

const USAGE = "использование: importCloudExport <каталог-выгрузки> [--apply] [--batch-size=N]";

/** Похоже на строку подключения — такое в аргументах не принимаем никогда. */
function looksLikeConnectionString(arg: string): boolean {
  return /^[a-z+]+:\/\//i.test(arg) || /(^|[^A-Za-z])(postgres(ql)?|DATABASE_URL)\s*=/.test(arg);
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let dir: string | undefined;
  let apply = false;
  let batchSize: number | undefined;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg.startsWith("--batch-size=")) {
      const value = Number(arg.slice("--batch-size=".length));
      if (!Number.isInteger(value) || value < 1 || value > 5000) {
        throw new CliError("--batch-size ожидает целое число от 1 до 5000");
      }
      batchSize = value;
    } else if (arg.startsWith("-")) {
      throw new CliError(`неизвестный ключ ${arg}\n${USAGE}`);
    } else if (dir === undefined) {
      // строку подключения через аргументы не принимаем: она попала бы в историю
      // shell и в список процессов; DATABASE_URL берётся только из окружения
      if (looksLikeConnectionString(arg)) throw new CliError("аргументом передаётся каталог выгрузки, а не строка подключения");
      dir = arg;
    } else {
      throw new CliError(`лишний аргумент\n${USAGE}`);
    }
  }

  if (dir === undefined) throw new CliError(`не указан каталог выгрузки\n${USAGE}`);
  return { dir, apply, ...(batchSize === undefined ? {} : { batchSize }) };
}

/** FileStore поверх настоящего каталога: читаются только файлы верхнего уровня. */
export function directoryStore(dir: string): FileStore {
  const root = resolve(dir);
  return {
    list: async () => {
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    },
    // basename отсекает любые попытки выйти за пределы каталога
    read: (name) => readFile(join(root, basename(name)))
  };
}

export async function main(argv: readonly string[], report: Reporter): Promise<number> {
  const options = parseArgs(argv);

  if (options.apply && !process.env["DATABASE_URL"]) {
    throw new CliError("для --apply нужна переменная окружения DATABASE_URL (значение нигде не печатается)");
  }

  // модуль с PrismaClient подключается лениво: в dry-run соединение не создаётся
  const openDb = options.apply
    ? async () => (await import("./prismaDb.js")).createPrismaImportDb()
    : undefined;

  report(options.apply ? "режим: --apply (запись в базу)" : "режим: dry-run (проверка файлов)");
  const outcome = await runImport({
    store: directoryStore(options.dir),
    apply: options.apply,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(openDb ? { openDb: () => lazyDb(openDb) } : {}),
    report
  });
  report(outcome.applied ? "готово: данные перенесены" : "готово: проверка выполнена, база не изменялась");
  return EXIT_OK;
}

/**
 * ImportDb создаётся асинхронно (динамический import), а runImport ждёт готовый
 * объект — оборачиваем: каждый метод дожидается загрузки адаптера.
 */
function lazyDb(open: () => Promise<ImportDb>): ImportDb {
  let pending: Promise<ImportDb> | undefined;
  const db = () => (pending ??= open());
  return {
    transaction: async (fn) => (await db()).transaction(fn),
    read: async (fn) => (await db()).read(fn),
    close: async () => {
      if (pending) await (await pending).close();
    }
  };
}

/** Запуск как скрипта: тесты импортируют модуль и main() сам по себе не стартует. */
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "неизвестная ошибка";
      process.stderr.write(`импорт остановлен: ${message}\n`);
      // ошибка аргументов — тот же «ничего не сделано», что и отказ проверок
      process.exitCode = error instanceof CliError ? EXIT_REFUSED : exitCodeFor(error);
    });
}
