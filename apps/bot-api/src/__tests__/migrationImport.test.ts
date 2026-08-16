/**
 * Тесты импортёра cloud-выгрузки: разбор файлов, восстановление типов,
 * контрольные суммы и логика отказов. Настоящая база не используется —
 * вместо неё адаптер в памяти, реализующий тот же интерфейс ImportDb.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CliError, parseArgs } from "../migration/importCloudExport.js";
import {
  ExportVerificationError,
  assertSafeFileName,
  loadExportBundle,
  parseCounts,
  parseFileEntries,
  parseTableFile,
  sha256Hex,
  type FileStore
} from "../migration/manifest.js";
import { setvalSql, writerFor } from "../migration/prismaDb.js";
import {
  PreflightError,
  assertTargetEmpty,
  checkExportIntegrity,
  findNonEmptyTables,
  importOrder
} from "../migration/preflight.js";
import { EXIT_REFUSED, EXIT_VERIFY_FAILED, PostImportVerificationError, exitCodeFor, runImport } from "../migration/run.js";
import { CORE_TABLES, UnknownTableError, assertKnownTable, specOf } from "../migration/tables.js";
import { RowConversionError, convertRow, convertValue, isRealCalendarDate } from "../migration/values.js";
import type { ConvertedRow } from "../migration/values.js";
import type { CoreTable, ImportableTable } from "../migration/tables.js";
import type { ImportDb, ImportWriter } from "../migration/db.js";

// ────────────────────────── вспомогательное: каталог выгрузки в памяти

type Rows = Partial<Record<ImportableTable, unknown[]>>;

const USER_ROW = {
  id: 1,
  tgUserId: "123456789012345",
  firstName: "Аня",
  username: null,
  tz: "Europe/Moscow",
  createdAt: "2026-07-09T10:00:00.000Z",
  dailyLimitOverride: null
};

const MEAL_ROW = {
  id: 10,
  userId: 1,
  photoFileId: "AgAC",
  photoThumbFileId: null,
  photoS3Key: null,
  tgMessageId: "4242",
  eatenAt: "2026-07-09T12:30:00.000Z",
  totalKcal: 512.5,
  totalProtein: 30,
  totalFat: 12.25,
  totalCarbs: 60,
  aiComment: "норм",
  overallConfidence: 0.8,
  source: "photo"
};

const MEAL_ITEM_ROW = {
  id: 100,
  mealId: 10,
  dish: "Овсянка",
  grams: 250,
  kcal: 300,
  protein: 10,
  fat: 5,
  carbs: 50,
  confidence: 0.9
};

const PROCESSED_UPDATE_ROW = { updateId: "9007199254740993", createdAt: "2026-07-09T12:31:00.000Z" };

function fileBytes(table: string, rows: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ table, count: rows.length, nextCursor: null, rows }));
}

/** Каталог выгрузки: манифест собирается из данных, sha256 считается честно. */
function makeStore(rows: Rows, tweak: (manifest: Record<string, unknown>, files: Map<string, Uint8Array>) => void = () => {}): FileStore {
  const files = new Map<string, Uint8Array>();
  const counts: Record<string, number | null> = {};
  const entries: Array<Record<string, unknown>> = [];

  for (const table of CORE_TABLES) counts[table] = rows[table]?.length ?? 0;
  for (const [table, tableRows] of Object.entries(rows) as Array<[ImportableTable, unknown[]]>) {
    const name = `${table}.json`;
    const bytes = fileBytes(table, tableRows);
    files.set(name, bytes);
    counts[table] = tableRows.length;
    entries.push({ table, file: name, rows: tableRows.length, sha256: sha256Hex(bytes) });
  }

  const manifest: Record<string, unknown> = { exportedAt: "2026-08-16T00:00:00.000Z", counts, files: entries };
  tweak(manifest, files);
  files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));

  return {
    list: async () => [...files.keys()],
    read: async (name) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error(`нет файла ${name}`);
      return bytes;
    }
  };
}

const FULL_ROWS: Rows = { User: [USER_ROW], Meal: [MEAL_ROW], MealItem: [MEAL_ITEM_ROW] };

// ────────────────────────── адаптер БД в памяти

type FakeDbOptions = {
  /** Стартовое состояние целевой базы */
  core?: Partial<Record<CoreTable, number>>;
  processedUpdate?: number | null;
  /** Подменить счётчики, которые вернёт сверка после коммита */
  countsAfterCommit?: Partial<Record<CoreTable, number>>;
  failOn?: ImportableTable;
};

function makeFakeDb(options: FakeDbOptions = {}) {
  const written = new Map<ImportableTable, ConvertedRow[]>();
  const log: string[] = [];
  let committed = false;
  let closed = false;
  let processedUpdate = options.processedUpdate ?? null;

  const countCore = (table: CoreTable): number => {
    if (committed && options.countsAfterCommit?.[table] !== undefined) return options.countsAfterCommit[table];
    return (options.core?.[table] ?? 0) + (written.get(table)?.length ?? 0);
  };

  const writer: ImportWriter = {
    countCoreTable: async (table) => countCore(table),
    countProcessedUpdate: async () => processedUpdate,
    ensureProcessedUpdateTable: async () => {
      log.push("ensure:ProcessedUpdate");
      if (processedUpdate === null) processedUpdate = 0;
    },
    insertRows: async (table, rows) => {
      if (options.failOn === table) throw new Error("сбой вставки");
      log.push(`insert:${table}:${rows.length}`);
      written.set(table, [...(written.get(table) ?? []), ...rows]);
      if (table === "ProcessedUpdate") processedUpdate = (processedUpdate ?? 0) + rows.length;
      return rows.length;
    },
    resetSequence: async (table, column) => {
      log.push(`setval:${table}.${column}`);
    }
  };

  const db: ImportDb = {
    transaction: async (fn) => {
      const result = await fn(writer);
      committed = true;
      return result;
    },
    read: async (fn) =>
      fn({
        countCoreTable: async (table) => countCore(table),
        countProcessedUpdate: async () => processedUpdate
      }),
    close: async () => {
      closed = true;
    }
  };

  return {
    db,
    log,
    written,
    isCommitted: () => committed,
    isClosed: () => closed
  };
}

function collectReport() {
  const lines: string[] = [];
  return { lines, report: (line: string) => lines.push(line) };
}

// ────────────────────────── восстановление типов

describe("восстановление типов по схеме", () => {
  it("BigInt приходит строкой и становится bigint", () => {
    expect(convertValue({ name: "tgUserId", kind: "bigint" }, "9007199254740993")).toBe(9007199254740993n);
    expect(convertValue({ name: "tgMessageId", kind: "bigint", nullable: true }, null)).toBeNull();
  });

  it("BigInt не принимает неточное число и мусор", () => {
    expect(() => convertValue({ name: "tgUserId", kind: "bigint" }, 9007199254740993)).toThrow();
    expect(() => convertValue({ name: "tgUserId", kind: "bigint" }, "12.5")).toThrow();
    expect(() => convertValue({ name: "tgUserId", kind: "bigint" }, "0x10")).toThrow();
  });

  it("ISO-строка становится Date с тем же моментом времени", () => {
    const value = convertValue({ name: "createdAt", kind: "dateTime" }, "2026-07-09T10:00:00.000Z");
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe("2026-07-09T10:00:00.000Z");
  });

  it("дата-время отвергает не-ISO строку", () => {
    expect(() => convertValue({ name: "createdAt", kind: "dateTime" }, "09.07.2026")).toThrow();
    expect(() => convertValue({ name: "createdAt", kind: "dateTime" }, "2026-07-09")).toThrow();
  });

  it("date-only остаётся строкой YYYY-MM-DD и проверяется по календарю", () => {
    expect(convertValue({ name: "date", kind: "dateOnly" }, "2026-02-28")).toBe("2026-02-28");
    expect(isRealCalendarDate("2024-02-29")).toBe(true);
    expect(isRealCalendarDate("2026-02-29")).toBe(false);
    expect(() => convertValue({ name: "date", kind: "dateOnly" }, "2026-02-30")).toThrow();
    expect(() => convertValue({ name: "date", kind: "dateOnly" }, "2026-7-9")).toThrow();
  });

  it("Decimal переносится строкой без потери точности", () => {
    const column = { name: "amount", kind: "decimal" } as const;
    expect(convertValue(column, "12345678901234567890.12345")).toBe("12345678901234567890.12345");
    expect(convertValue(column, 10.5)).toBe("10.5");
    expect(() => convertValue(column, "1e5")).toThrow();
  });

  it("Json сохраняется как есть, включая вложенные структуры", () => {
    const column = { name: "statsJson", kind: "json" } as const;
    const value = { kcal: 1800, days: [1, 2], nested: { ok: true, note: null } };
    expect(convertValue(column, value)).toEqual(value);
    // JSON-null в NOT NULL колонке допустим: это значение, а не SQL NULL
    expect(convertValue(column, null)).toBeNull();
  });

  it("int держится в границах int4, float принимает дробное", () => {
    expect(convertValue({ name: "targetKcal", kind: "int", nullable: true }, 2200)).toBe(2200);
    expect(() => convertValue({ name: "targetKcal", kind: "int" }, 2200.5)).toThrow();
    expect(() => convertValue({ name: "targetKcal", kind: "int" }, 2_147_483_648)).toThrow();
    expect(convertValue({ name: "weightKg", kind: "float", nullable: true }, 72.4)).toBe(72.4);
  });

  it("enum принимает только значения из схемы", () => {
    const column = { name: "source", kind: "enum", enumValues: ["photo", "text", "manual"] } as const;
    expect(convertValue(column, "text")).toBe("text");
    expect(() => convertValue(column, "voice")).toThrow();
  });

  it("string[] требует массив строк", () => {
    expect(convertValue({ name: "allergies", kind: "stringArray" }, ["орехи"])).toEqual(["орехи"]);
    expect(() => convertValue({ name: "allergies", kind: "stringArray" }, "орехи")).toThrow();
    expect(() => convertValue({ name: "allergies", kind: "stringArray" }, [1])).toThrow();
  });

  it("строка целиком: все колонки схемы на месте", () => {
    const row = convertRow("User", specOf("User"), USER_ROW, 0);
    expect(row["tgUserId"]).toBe(123456789012345n);
    expect(row["createdAt"]).toBeInstanceOf(Date);
    expect(row["username"]).toBeNull();
    expect(Object.keys(row).sort()).toEqual(specOf("User").columns.map((c) => c.name).sort());
  });

  it("лишняя колонка в выгрузке — отказ, а не тихое игнорирование", () => {
    expect(() => convertRow("User", specOf("User"), { ...USER_ROW, secretFlag: true }, 3)).toThrow(RowConversionError);
  });

  it("пропущенная NOT NULL колонка — отказ", () => {
    const withoutTz: Record<string, unknown> = { ...USER_ROW };
    delete withoutTz["tz"];
    expect(() => convertRow("User", specOf("User"), withoutTz, 0)).toThrow(/tz/);
  });

  it("сообщение об ошибке не печатает само значение (в выгрузке — персональные данные)", () => {
    const secret = "+79991234567";
    try {
      convertRow("User", specOf("User"), { ...USER_ROW, tz: 42, firstName: secret }, 7);
      expect.unreachable("должно было упасть");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("User[строка 7].tz");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("42");
    }
  });
});

// ────────────────────────── манифест и контрольные суммы

describe("манифест и контрольные суммы", () => {
  it("sha256 считается по байтам файла", () => {
    const bytes = new TextEncoder().encode('{"rows":[]}');
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("расхождение sha256 останавливает импорт", async () => {
    const store = makeStore(FULL_ROWS, (_manifest, files) => {
      files.set("User.json", fileBytes("User", [{ ...USER_ROW, firstName: "подменили" }]));
    });
    await expect(loadExportBundle(store)).rejects.toThrow(/sha256/);
  });

  it("расхождение числа строк с манифестом останавливает импорт", async () => {
    const store = makeStore(FULL_ROWS, (manifest) => {
      const counts = manifest["counts"] as Record<string, number>;
      counts["User"] = 5;
      (manifest["files"] as Array<Record<string, unknown>>)[0]!["rows"] = 5;
    });
    await expect(loadExportBundle(store)).rejects.toThrow(/строк/);
  });

  it("незакрытая пагинация (nextCursor) — признак неполной выгрузки", () => {
    const rows = [USER_ROW];
    const bytes = new TextEncoder().encode(JSON.stringify({ table: "User", rows, nextCursor: "1" }));
    expect(() =>
      parseTableFile({ table: "User", file: "User.json", sha256: sha256Hex(bytes), expectedRows: 1 }, bytes)
    ).toThrow(/nextCursor/);
  });

  it("файл без sha256 в манифесте не принимается", () => {
    const counts = { User: 1 } as Record<string, number | null>;
    expect(() => parseFileEntries({ files: [{ table: "User", file: "User.json", rows: 1 }] }, counts)).toThrow(
      ExportVerificationError
    );
  });

  it("files-карта без имени файла: имя достраивается из имени таблицы", () => {
    // ровно та форма, что пишет мост выгрузки: ключ — таблица, имени файла в записи нет
    const manifest = {
      counts: { User: 15, Meal: 3 },
      files: {
        User: { rows: 15, sha256: "a".repeat(64) },
        Meal: { rows: 3, sha256: "B".repeat(64) }
      }
    };
    const counts = { User: 15, Meal: 3 } as Record<string, number | null>;
    expect(parseFileEntries(manifest, counts)).toEqual([
      { table: "User", file: "User.json", sha256: "a".repeat(64), expectedRows: 15 },
      { table: "Meal", file: "Meal.json", sha256: "b".repeat(64), expectedRows: 3 }
    ]);
  });

  it("явное имя файла в карте важнее умолчания, а в списке имя по-прежнему обязательно", () => {
    const counts = { User: 1 } as Record<string, number | null>;
    const sha256 = "c".repeat(64);
    expect(parseFileEntries({ files: { User: { rows: 1, sha256, file: "users-part1.json" } } }, counts)[0]?.file).toBe(
      "users-part1.json"
    );
    // в списке ключа-таблицы нет, достраивать имя не из чего
    expect(() => parseFileEntries({ files: [{ table: "User", rows: 1, sha256 }] }, counts)).toThrow(/нет имени файла/);
    // мусор вместо имени не подменяется умолчанием
    expect(() => parseFileEntries({ files: { User: { rows: 1, sha256, file: 42 } } }, counts)).toThrow(/нет имени файла/);
  });

  it("выгрузка с files-картой читается целиком", async () => {
    const store = makeStore(FULL_ROWS, (manifest) => {
      const list = manifest["files"] as Array<Record<string, unknown>>;
      manifest["files"] = Object.fromEntries(
        list.map((entry) => [entry["table"] as string, { rows: entry["rows"], sha256: entry["sha256"] }])
      );
    });
    const bundle = await loadExportBundle(store);
    expect(bundle.files.map((f) => f.file)).toEqual(["User.json", "Meal.json", "MealItem.json"]);
    expect(bundle.rows.get("User")?.[0]?.["tgUserId"]).toBe(123456789012345n);
    // файлы разобраны по имени из умолчания, лишними их никто не считает
    expect(bundle.warnings.some((w) => w.includes("не упомянут в манифесте"))).toBe(false);
  });

  it("манифест обязан содержать счётчики всех таблиц ядра", () => {
    expect(() => parseCounts({ counts: { User: 1 } })).toThrow(/нет счётчика/);
    expect(() => parseCounts({ counts: Object.fromEntries(CORE_TABLES.map((t) => [t, null])) })).toThrow(/null/);
  });

  it("имя файла из манифеста не может уводить из каталога", () => {
    expect(assertSafeFileName("User.json")).toBe("User.json");
    expect(() => assertSafeFileName("../../etc/passwd")).toThrow(ExportVerificationError);
    expect(() => assertSafeFileName("/etc/passwd")).toThrow(ExportVerificationError);
  });

  it("отсутствующий manifest.json — отказ", async () => {
    const store: FileStore = { list: async () => ["User.json"], read: async () => new Uint8Array() };
    await expect(loadExportBundle(store)).rejects.toThrow(/manifest\.json/);
  });

  it("непустая таблица без файла — отказ, пустая без файла — предупреждение", async () => {
    const missingFile = makeStore(FULL_ROWS, (manifest) => {
      const files = manifest["files"] as Array<Record<string, unknown>>;
      manifest["files"] = files.filter((f) => f["table"] !== "User");
    });
    await expect(loadExportBundle(missingFile)).rejects.toThrow(/нет файла для непустой таблицы User/);

    const bundle = await loadExportBundle(makeStore({ User: [USER_ROW] }));
    expect(bundle.warnings.some((w) => w.includes("Profile"))).toBe(true);
  });

  it("RecognitionLock игнорируется явно, лишние файлы — с предупреждением", async () => {
    const store = makeStore(FULL_ROWS, (_manifest, files) => {
      files.set("RecognitionLock.json", new TextEncoder().encode("{}"));
      files.set("notes.txt", new TextEncoder().encode("привет"));
    });
    const bundle = await loadExportBundle(store);
    expect(bundle.warnings.some((w) => w.includes("RecognitionLock") && w.includes("не переносится"))).toBe(true);
    expect(bundle.warnings.some((w) => w.includes("notes.txt"))).toBe(true);
    expect(bundle.rows.has("MealItem")).toBe(true);
  });

  it("таблица вне списка FitHub не принимается ни из манифеста, ни из кода", () => {
    expect(assertKnownTable("User")).toBe("User");
    expect(() => assertKnownTable("users")).toThrow(UnknownTableError);
    // таблицы соседнего продукта пишутся строчными — им сюда хода нет
    expect(() => assertKnownTable("subscriptions")).toThrow(UnknownTableError);
    expect(() => assertKnownTable("pg_class")).toThrow(UnknownTableError);
    expect(() => parseCounts({ counts: { clients: 1 } })).toThrow(UnknownTableError);
  });
});

// ────────────────────────── целостность выгрузки

describe("целостность выгрузки", () => {
  it("ссылка на отсутствующего родителя — отказ без упоминания значений", async () => {
    const bundle = await loadExportBundle(makeStore({ User: [USER_ROW], Meal: [{ ...MEAL_ROW, userId: 999 }] }));
    const problems = checkExportIntegrity(bundle);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Meal.userId");
    expect(problems[0]).not.toContain("999");
  });

  it("дубликат первичного ключа — отказ", async () => {
    const bundle = await loadExportBundle(makeStore({ User: [USER_ROW, { ...USER_ROW, tgUserId: "5" }] }));
    expect(checkExportIntegrity(bundle).join()).toContain("User");
  });

  it("nullable-ссылка AiUsage.userId = null проходит", async () => {
    const aiUsage = {
      id: 1,
      userId: null,
      client: "vision",
      model: "m",
      purpose: "probe",
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      createdAt: "2026-07-09T10:00:00.000Z"
    };
    const bundle = await loadExportBundle(makeStore({ AiUsage: [aiUsage] }));
    expect(checkExportIntegrity(bundle)).toEqual([]);
  });

  it("порядок записи — родители раньше потомков, ProcessedUpdate последним", async () => {
    const bundle = await loadExportBundle(makeStore({ ...FULL_ROWS, ProcessedUpdate: [PROCESSED_UPDATE_ROW] }));
    expect(importOrder(bundle)).toEqual(["User", "Meal", "MealItem", "ProcessedUpdate"]);
  });
});

// ────────────────────────── отказ при непустой базе

describe("отказ при непустой целевой базе", () => {
  const empty = { core: Object.fromEntries(CORE_TABLES.map((t) => [t, 0])) as Record<CoreTable, number>, processedUpdate: null };

  it("пустая база проходит", () => {
    expect(findNonEmptyTables(empty)).toEqual([]);
    expect(() => assertTargetEmpty(empty)).not.toThrow();
  });

  it("любая непустая таблица ядра останавливает импорт", () => {
    const state = { ...empty, core: { ...empty.core, Meal: 3 } };
    expect(findNonEmptyTables(state)).toEqual(["Meal: 3 строк"]);
    expect(() => assertTargetEmpty(state)).toThrow(PreflightError);
  });

  it("непустой ProcessedUpdate тоже останавливает, пустой — нет", () => {
    expect(() => assertTargetEmpty({ ...empty, processedUpdate: 7 })).toThrow(PreflightError);
    expect(() => assertTargetEmpty({ ...empty, processedUpdate: 0 })).not.toThrow();
  });
});

// ────────────────────────── сценарий импорта целиком

describe("сценарий импорта", () => {
  it("dry-run по умолчанию: база не открывается, печатаются только счётчики", async () => {
    const { lines, report } = collectReport();
    const fake = makeFakeDb();
    const outcome = await runImport({
      store: makeStore(FULL_ROWS),
      apply: false,
      openDb: () => {
        throw new Error("dry-run не должен открывать базу");
      },
      report
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.counts).toMatchObject({ User: 1, Meal: 1, MealItem: 1, Profile: 0 });
    expect(fake.log).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("User: 1");
    expect(text).toContain("dry-run");
    // ни одного значения из данных в выводе
    expect(text).not.toContain("Аня");
    expect(text).not.toContain("AgAC");
    expect(text).not.toContain("123456789012345");
  });

  it("--apply: одна транзакция, порядок зависимостей, затем setval", async () => {
    const fake = makeFakeDb();
    const { report } = collectReport();
    const outcome = await runImport({
      store: makeStore({ ...FULL_ROWS, ProcessedUpdate: [PROCESSED_UPDATE_ROW] }),
      apply: true,
      openDb: () => fake.db,
      report
    });

    expect(outcome.applied).toBe(true);
    expect(fake.log).toEqual([
      "insert:User:1",
      "insert:Meal:1",
      "insert:MealItem:1",
      "ensure:ProcessedUpdate",
      "insert:ProcessedUpdate:1",
      "setval:User.id",
      "setval:Meal.id",
      "setval:MealItem.id",
      "setval:DailyAdvice.id",
      "setval:Subscription.id",
      "setval:AiUsage.id"
    ]);
    // Profile и UsageCounter без autoincrement — им setval не нужен
    expect(fake.log.some((l) => l.startsWith("setval:Profile"))).toBe(false);
    expect(fake.log.some((l) => l.startsWith("setval:UsageCounter"))).toBe(false);
    expect(fake.isClosed()).toBe(true);
    expect(fake.written.get("User")?.[0]?.["tgUserId"]).toBe(123456789012345n);
  });

  it("--apply в непустую базу: отказ до единой вставки", async () => {
    const fake = makeFakeDb({ core: { User: 1 } });
    const { report } = collectReport();
    await expect(
      runImport({ store: makeStore(FULL_ROWS), apply: true, openDb: () => fake.db, report })
    ).rejects.toThrow(PreflightError);
    expect(fake.log).toEqual([]);
    expect(fake.written.size).toBe(0);
    expect(fake.isClosed()).toBe(true);
  });

  it("большая выгрузка пишется пачками по batchSize", async () => {
    const users = Array.from({ length: 5 }, (_, i) => ({ ...USER_ROW, id: i + 1, tgUserId: String(1000 + i) }));
    const fake = makeFakeDb();
    const { report } = collectReport();
    await runImport({ store: makeStore({ User: users }), apply: true, openDb: () => fake.db, report, batchSize: 2 });
    expect(fake.log.filter((l) => l.startsWith("insert:User"))).toEqual(["insert:User:2", "insert:User:2", "insert:User:1"]);
  });

  it("битая выгрузка не доходит до базы даже с --apply", async () => {
    const fake = makeFakeDb();
    const { report } = collectReport();
    const broken = makeStore(FULL_ROWS, (_manifest, files) => {
      files.set("Meal.json", fileBytes("Meal", [{ ...MEAL_ROW, source: "voice" }]));
    });
    await expect(runImport({ store: broken, apply: true, openDb: () => fake.db, report })).rejects.toThrow();
    expect(fake.log).toEqual([]);
  });

  it("расхождение счётчиков после коммита — отдельный код возврата", async () => {
    const fake = makeFakeDb({ countsAfterCommit: { MealItem: 0 } });
    const { report } = collectReport();
    const failure = runImport({ store: makeStore(FULL_ROWS), apply: true, openDb: () => fake.db, report });
    await expect(failure).rejects.toThrow(PostImportVerificationError);
    await failure.catch((error: unknown) => {
      expect(exitCodeFor(error)).toBe(EXIT_VERIFY_FAILED);
    });
    expect(fake.isClosed()).toBe(true);
  });

  it("отказ до записи и ошибка аргументов дают код 1", () => {
    expect(exitCodeFor(new PreflightError("не пуста"))).toBe(EXIT_REFUSED);
    expect(exitCodeFor(new ExportVerificationError("битый файл"))).toBe(EXIT_REFUSED);
  });
});

// ────────────────────────── SQL адаптера Prisma

describe("setval для sequence", () => {
  /** Заглушка транзакции Prisma: SQL никуда не уходит, только записывается. */
  function fakeTx(sequence: string | null) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      $queryRaw: async () => [{ seq: sequence }],
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        executed.push({ sql, params });
        return 1;
      }
    } as unknown as Parameters<typeof writerFor>[0];
    return { tx, executed };
  }

  it("имя sequence идёт параметром с явным приведением к regclass", async () => {
    const { tx, executed } = fakeTx('public."User_id_seq"');
    await writerFor(tx).resetSequence("User", "id");

    expect(executed).toHaveLength(1);
    expect(executed[0]?.params).toEqual(['public."User_id_seq"']);
    // без ::regclass Postgres не выводит тип $1 и запрос падает ещё до setval
    expect(executed[0]?.sql).toContain("setval($1::regclass,");
    expect(executed[0]?.sql).not.toMatch(/setval\(\$1\s*,/);
  });

  it("в текст запроса попадают только идентификаторы из белого списка", () => {
    expect(setvalSql("MealItem", "id")).toBe(
      'SELECT setval($1::regclass, COALESCE((SELECT MAX("id") FROM "MealItem"), 0) + 1, false)'
    );
    // ни имя sequence, ни что-либо ещё из базы в текст не подставляется
    expect(setvalSql("Meal", "id")).not.toContain("seq");
  });

  it("не-autoincrement колонка и отсутствующая sequence — отказ без запроса", async () => {
    const noSerial = fakeTx('public."Profile_id_seq"');
    await expect(writerFor(noSerial.tx).resetSequence("Profile", "userId")).rejects.toThrow(/autoincrement/);
    expect(noSerial.executed).toEqual([]);

    const missing = fakeTx(null);
    await expect(writerFor(missing.tx).resetSequence("User", "id")).rejects.toThrow(/схема целевой базы/);
    expect(missing.executed).toEqual([]);
  });
});

// ────────────────────────── аргументы командной строки

describe("аргументы командной строки", () => {
  it("по умолчанию dry-run, запись только по --apply", () => {
    expect(parseArgs(["/tmp/export"])).toEqual({ dir: "/tmp/export", apply: false });
    expect(parseArgs(["/tmp/export", "--apply"])).toEqual({ dir: "/tmp/export", apply: true });
    expect(parseArgs(["/tmp/export", "--apply", "--dry-run"])).toEqual({ dir: "/tmp/export", apply: false });
  });

  it("каталог обязателен, лишние и неизвестные ключи отвергаются", () => {
    expect(() => parseArgs([])).toThrow(CliError);
    expect(() => parseArgs(["/tmp/a", "/tmp/b"])).toThrow(CliError);
    expect(() => parseArgs(["/tmp/a", "--force"])).toThrow(CliError);
    expect(() => parseArgs(["/tmp/a", "--batch-size=0"])).toThrow(CliError);
    expect(parseArgs(["/tmp/a", "--batch-size=250"]).batchSize).toBe(250);
  });

  it("строку подключения аргументом не принимаем — только DATABASE_URL из окружения", () => {
    expect(() => parseArgs(["postgresql://host/db"])).toThrow(CliError);
    expect(() => parseArgs(["DATABASE_URL=postgres://x"])).toThrow(CliError);
  });
});
