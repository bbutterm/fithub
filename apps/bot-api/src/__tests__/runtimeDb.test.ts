/**
 * Блокировки распознавания и дедупликация вебхуков поверх заглушки Prisma:
 * настоящей базы в тестах нет, поэтому проверяем то, что от них зависит в проде —
 * какой SQL уходит (только DML), как читается число затронутых строк и что при
 * ошибке база не блокирует пользователя (fail-open).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { sql: string; params: unknown[] };

const db = vi.hoisted(() => {
  const calls: Call[] = [];
  let handler: (call: Call) => Promise<number> = async () => 1;
  return {
    calls,
    /** Ответ заглушки на конкретный запрос: число «затронутых строк» или бросок ошибки. */
    respond(next: (call: Call) => Promise<number>) {
      handler = next;
    },
    reset() {
      calls.length = 0;
      handler = async () => 1;
    },
    // $executeRaw вызывается как tagged template: (strings, ...params)
    executeRaw(strings: TemplateStringsArray, ...params: unknown[]): Promise<number> {
      const call = { sql: strings.join(" ? ").replace(/\s+/g, " ").trim(), params };
      calls.push(call);
      return handler(call);
    }
  };
});

vi.mock("../db.js", () => ({ prisma: { $executeRaw: db.executeRaw } }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

beforeEach(() => {
  db.reset();
  vi.resetModules(); // сбрасывает состояние модулей между тестами (разовая чистка ProcessedUpdate)
});

const locks = () => import("../services/locks.js");
const updates = () => import("../services/updates.js");

describe("блокировка распознавания", () => {
  it("снимает протухшие блокировки и берёт слот вставкой", async () => {
    const { acquireRecognitionLock } = await locks();
    expect(await acquireRecognitionLock(42)).toBe(true);

    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]?.sql).toBe(
      'DELETE FROM "RecognitionLock" WHERE "userId" = ? AND "lockedAt" < now() - interval \'90 seconds\''
    );
    expect(db.calls[0]?.params).toEqual([42]);
    expect(db.calls[1]?.sql).toBe(
      'INSERT INTO "RecognitionLock" ("userId") VALUES ( ? ) ON CONFLICT DO NOTHING'
    );
    expect(db.calls[1]?.params).toEqual([42]);
  });

  it("ON CONFLICT DO NOTHING без вставки — слот занят", async () => {
    const { acquireRecognitionLock } = await locks();
    db.respond(async (call) => (call.sql.startsWith("INSERT") ? 0 : 1));
    expect(await acquireRecognitionLock(7)).toBe(false);
  });

  it("ошибка базы не блокирует пользователя (fail-open)", async () => {
    const { acquireRecognitionLock } = await locks();
    db.respond(async () => {
      throw new Error("permission denied");
    });
    expect(await acquireRecognitionLock(7)).toBe(true);
  });

  it("снятие блокировки — DELETE по userId, ошибка проглатывается", async () => {
    const { releaseRecognitionLock } = await locks();
    await releaseRecognitionLock(7);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toBe('DELETE FROM "RecognitionLock" WHERE "userId" = ?');
    expect(db.calls[0]?.params).toEqual([7]);

    db.respond(async () => {
      throw new Error("нет связи");
    });
    await expect(releaseRecognitionLock(7)).resolves.toBeUndefined();
  });
});

describe("дедупликация вебхуков", () => {
  it("первый апдейт: чистка старых записей + вставка, дубликата нет", async () => {
    const { isDuplicateUpdate } = await updates();
    expect(await isDuplicateUpdate(100)).toBe(false);

    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]?.sql).toBe('DELETE FROM "ProcessedUpdate" WHERE "createdAt" < now() - interval \'2 days\'');
    expect(db.calls[0]?.params).toEqual([]);
    expect(db.calls[1]?.sql).toBe(
      'INSERT INTO "ProcessedUpdate" ("updateId") VALUES ( ? ) ON CONFLICT DO NOTHING'
    );
    expect(db.calls[1]?.params).toEqual([100]);
  });

  it("чистка старых записей — один раз на инстанс", async () => {
    const { isDuplicateUpdate } = await updates();
    await isDuplicateUpdate(1);
    db.reset();
    await isDuplicateUpdate(2);
    expect(db.calls.map((c) => c.sql.slice(0, 6))).toEqual(["INSERT"]);
  });

  it("конфликт по updateId — апдейт уже обработан", async () => {
    const { isDuplicateUpdate } = await updates();
    db.respond(async (call) => (call.sql.startsWith("INSERT") ? 0 : 1));
    expect(await isDuplicateUpdate(100)).toBe(true);
  });

  it("ошибка базы — апдейт обрабатывается, а не теряется (fail-open)", async () => {
    const { isDuplicateUpdate } = await updates();
    db.respond(async () => {
      throw new Error("permission denied");
    });
    expect(await isDuplicateUpdate(100)).toBe(false);
  });

  it("неудачная чистка повторится на следующем апдейте, флаг не взводится", async () => {
    const { isDuplicateUpdate } = await updates();
    db.respond(async (call) => {
      if (call.sql.startsWith("DELETE")) throw new Error("таймаут");
      return 1;
    });
    expect(await isDuplicateUpdate(1)).toBe(false);

    db.reset();
    expect(await isDuplicateUpdate(2)).toBe(false);
    expect(db.calls.map((c) => c.sql.slice(0, 6))).toEqual(["DELETE", "INSERT"]);
  });
});

/**
 * DDL ищем по ключевым словам на границе слова, а не по подстроке: колонка "createdAt"
 * содержит create, но CREATE-оператором не является.
 */
const DDL_KEYWORD = /\b(create|alter|drop|truncate)\b/i;
/** Чем вообще разрешено начинаться запросу рантайма. */
const DML_START = /^(insert|update|delete|select|with)\b/i;

describe("служебные таблицы не создаются на лету", () => {
  it("ни один запрос рантайма не содержит DDL", async () => {
    const { acquireRecognitionLock, releaseRecognitionLock } = await locks();
    const { isDuplicateUpdate } = await updates();
    await acquireRecognitionLock(1);
    await releaseRecognitionLock(1);
    await isDuplicateUpdate(1);

    expect(db.calls.length).toBeGreaterThan(0);
    for (const call of db.calls) {
      const statements = call.sql.split(";").filter((s) => s.trim() !== "");
      expect(statements.length, call.sql).toBeGreaterThan(0);
      for (const statement of statements) {
        // каждый оператор начинается с DML-глагола…
        expect(statement.trim(), call.sql).toMatch(DML_START);
        // …и нигде внутри нет DDL-ключевого слова
        expect(statement, call.sql).not.toMatch(DDL_KEYWORD);
      }
    }
  });
});
