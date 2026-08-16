/**
 * Служебные таблицы RecognitionLock и ProcessedUpdate: раньше их создавал сам рантайм
 * (CREATE TABLE IF NOT EXISTS), из-за чего роль приложения без CREATE на схеме падала
 * с permission denied. Тесты стерегут две вещи:
 *   1) в рантайм-коде нет DDL — таблицы приходят только из миграций;
 *   2) модели в schema.prisma и SQL миграции совпадают с прежним ленивым DDL
 *      один в один (имена, типы, NOT NULL, умолчание now(), первичный ключ).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const srcRoot = path.join(appRoot, "src");

/**
 * Единственное место, где DDL остаётся легальным, — разовый мост импорта cloud-выгрузки
 * (CLI, запускается вручную под привилегированной ролью, в продуктовый рантайм не входит).
 */
const DDL_ALLOWED = ["migration/prismaDb.ts"];

async function runtimeSources(): Promise<string[]> {
  const entries = await readdir(srcRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.relative(srcRoot, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join("/"))
    .filter((rel) => !rel.startsWith("__tests__/"))
    .sort();
}

describe("в рантайме нет DDL", () => {
  it("CREATE TABLE встречается только в мосте импорта", async () => {
    const files = await runtimeSources();
    expect(files.length).toBeGreaterThan(10); // страховка от «сканировали пустоту»

    const withDdl: string[] = [];
    for (const rel of files) {
      const code = await readFile(path.join(srcRoot, rel), "utf8");
      if (/create\s+table/i.test(code)) withDdl.push(rel);
    }
    expect(withDdl).toEqual(DDL_ALLOWED);
  });

  it("в дедупликации и блокировках нет ни DDL, ни флагов готовности таблицы", async () => {
    for (const rel of ["services/locks.ts", "services/updates.ts", "api/server.ts"]) {
      const code = await readFile(path.join(srcRoot, rel), "utf8");
      expect(code, rel).not.toMatch(/create\s+table/i);
      expect(code, rel).not.toContain("$executeRawUnsafe");
      expect(code, rel).not.toMatch(/tableReady/i);
    }
  });
});

describe("schema.prisma описывает служебные таблицы", () => {
  async function schema(): Promise<string> {
    return readFile(path.join(appRoot, "prisma", "schema.prisma"), "utf8");
  }

  function modelBody(source: string, model: string): string {
    const match = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
    expect(match, `модель ${model} не найдена`).not.toBeNull();
    return match![1]!;
  }

  it("RecognitionLock: userId Int @id + lockedAt timestamptz с now()", async () => {
    const body = modelBody(await schema(), "RecognitionLock");
    expect(body).toMatch(/userId\s+Int\s+@id\s*$/m);
    expect(body).toMatch(/lockedAt\s+DateTime\s+@default\(now\(\)\)\s+@db\.Timestamptz\(6\)/);
    // связи с User нет намеренно: прежняя ленивая таблица тоже была без внешнего ключа
    expect(body).not.toContain("@relation");
  });

  it("ProcessedUpdate: updateId BigInt @id + createdAt timestamptz с now()", async () => {
    const body = modelBody(await schema(), "ProcessedUpdate");
    expect(body).toMatch(/updateId\s+BigInt\s+@id\s*$/m);
    expect(body).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)\s+@db\.Timestamptz\(6\)/);
    expect(body).not.toContain("@relation");
  });
});

describe("миграция служебных таблиц", () => {
  const MIGRATION_DIR = "20260816120000_runtime_service_tables";

  /**
   * Разбираем только исполняемый SQL: шапка миграции сама упоминает «CREATE TABLE IF NOT EXISTS»,
   * и подсчёт по сырому тексту видел бы лишний оператор. Комментарии выкидываем, а операторы
   * дополнительно ищем с начала строки — чтобы упоминание в тексте не могло сойти за DDL.
   */
  async function migrationSql(): Promise<string> {
    const raw = await readFile(path.join(appRoot, "prisma", "migrations", MIGRATION_DIR, "migration.sql"), "utf8");
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  }

  it("создаёт обе таблицы в точности как прежний ленивый DDL", async () => {
    const sql = await migrationSql();
    // «INTEGER PRIMARY KEY» / «BIGINT PRIMARY KEY» + TIMESTAMPTZ NOT NULL DEFAULT now()
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "RecognitionLock"/);
    expect(sql).toMatch(/"userId" INTEGER NOT NULL/);
    expect(sql).toMatch(/"lockedAt" TIMESTAMPTZ\(6\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/CONSTRAINT "RecognitionLock_pkey" PRIMARY KEY \("userId"\)/);

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "ProcessedUpdate"/);
    expect(sql).toMatch(/"updateId" BIGINT NOT NULL/);
    expect(sql).toMatch(/"createdAt" TIMESTAMPTZ\(6\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/CONSTRAINT "ProcessedUpdate_pkey" PRIMARY KEY \("updateId"\)/);
  });

  it("идемпотентна и ничего не трогает, кроме двух служебных таблиц", async () => {
    const sql = await migrationSql();
    const created = [...sql.matchAll(/^\s*CREATE TABLE(?: IF NOT EXISTS)? "(\w+)"/gim)].map((m) => m[1]);
    expect(created).toEqual(["RecognitionLock", "ProcessedUpdate"]);
    // в базе, где ленивый DDL уже отработал, миграция должна проходить как no-op:
    // других CREATE TABLE нет, и каждый из двух — с IF NOT EXISTS
    expect(sql.match(/^\s*CREATE TABLE/gim)).toHaveLength(created.length);
    expect(sql.match(/^\s*CREATE TABLE IF NOT EXISTS/gim)).toHaveLength(created.length);
    expect(sql).not.toMatch(/\b(DROP|ALTER|TRUNCATE|DELETE)\b/i);
  });

  it("старые миграции не изменены — служебные таблицы только в новой", async () => {
    const dirs = (await readdir(path.join(appRoot, "prisma", "migrations"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toContain(MIGRATION_DIR);
    for (const dir of dirs.filter((d) => d !== MIGRATION_DIR)) {
      const sql = await readFile(path.join(appRoot, "prisma", "migrations", dir, "migration.sql"), "utf8");
      expect(sql, dir).not.toContain("RecognitionLock");
      expect(sql, dir).not.toContain("ProcessedUpdate");
    }
  });
});
