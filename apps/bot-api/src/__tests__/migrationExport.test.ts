import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  BadCursorError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MIGRATION_TABLES,
  type ExportPage,
  type MigrationExportDeps,
  isMigrationAuthorized,
  migrationQuerySchema,
  parseBigIntCursor,
  parseIntCursor,
  parseUsageCursor,
  pickMigrationQuery,
  registerMigrationExportRoutes,
  serializeExportRow,
  serializeExportValue
} from "../api/migrationExport.js";

const SECRET = "s3cret-migration-token";

describe("migration bridge: авторизация", () => {
  it("выключен при пустом секрете — даже «правильный» заголовок не проходит", () => {
    expect(isMigrationAuthorized("Bearer ", "")).toBe(false);
    expect(isMigrationAuthorized("Bearer anything", "")).toBe(false);
    expect(isMigrationAuthorized(undefined, "")).toBe(false);
  });

  it("пропускает только точное совпадение Bearer-секрета", () => {
    expect(isMigrationAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isMigrationAuthorized(undefined, SECRET)).toBe(false);
    expect(isMigrationAuthorized("", SECRET)).toBe(false);
    expect(isMigrationAuthorized(SECRET, SECRET)).toBe(false);
    expect(isMigrationAuthorized(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(isMigrationAuthorized(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isMigrationAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isMigrationAuthorized(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isMigrationAuthorized(`Bearer  ${SECRET}`, SECRET)).toBe(false);
  });
});

describe("migration bridge: сериализация", () => {
  it("BigInt → строка, Date → ISO", () => {
    const row = serializeExportRow({
      id: 7,
      tgUserId: 9007199254740993n,
      createdAt: new Date("2026-07-10T08:30:00.000Z"),
      firstName: null
    });
    expect(row).toEqual({
      id: 7,
      tgUserId: "9007199254740993",
      createdAt: "2026-07-10T08:30:00.000Z",
      firstName: null
    });
  });

  it("обходит вложенные Json-поля и массивы", () => {
    const value = serializeExportValue({
      allergies: ["орехи", "мёд"],
      statsJson: { days: [{ at: new Date("2026-01-01T00:00:00.000Z"), tgMessageId: 12n }], kcal: 1800.5 }
    });
    expect(value).toEqual({
      allergies: ["орехи", "мёд"],
      statsJson: { days: [{ at: "2026-01-01T00:00:00.000Z", tgMessageId: "12" }], kcal: 1800.5 }
    });
  });

  it("результат сериализуется JSON.stringify без ошибки BigInt", () => {
    expect(() => JSON.stringify(serializeExportRow({ tgMessageId: 1n }))).not.toThrow();
  });
});

describe("migration bridge: валидация запроса", () => {
  it("по умолчанию mode=counts и безопасный limit", () => {
    const parsed = migrationQuerySchema.parse({});
    expect(parsed.mode).toBe("counts");
    expect(parsed.limit).toBe(DEFAULT_LIMIT);
  });

  it("limit приводится из строки и ограничен сверху", () => {
    expect(migrationQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    expect(migrationQuerySchema.safeParse({ limit: String(MAX_LIMIT + 1) }).success).toBe(false);
    expect(migrationQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(migrationQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });

  it("mode=export требует известную таблицу", () => {
    expect(migrationQuerySchema.safeParse({ mode: "export" }).success).toBe(false);
    expect(migrationQuerySchema.safeParse({ mode: "export", table: "Meal" }).success).toBe(true);
    expect(migrationQuerySchema.safeParse({ mode: "export", table: "meal" }).success).toBe(false);
    expect(migrationQuerySchema.safeParse({ mode: "dump", table: "Meal" }).success).toBe(false);
  });

  it("RecognitionLock не выгружается, ProcessedUpdate — да", () => {
    expect(migrationQuerySchema.safeParse({ mode: "export", table: "RecognitionLock" }).success).toBe(false);
    expect(migrationQuerySchema.safeParse({ mode: "export", table: "ProcessedUpdate" }).success).toBe(true);
    expect([...MIGRATION_TABLES]).toEqual([
      "User",
      "Profile",
      "Meal",
      "MealItem",
      "DailyAdvice",
      "Subscription",
      "UsageCounter",
      "AiUsage",
      "ProcessedUpdate"
    ]);
  });

  it("посторонние параметры отклоняются", () => {
    expect(migrationQuerySchema.safeParse({ where: "1=1" }).success).toBe(false);
    expect(migrationQuerySchema.safeParse({ cursor: "x".repeat(129) }).success).toBe(false);
  });

  it("до схемы доходят только свои четыре параметра", () => {
    expect(
      pickMigrationQuery({
        mode: "export",
        table: "Meal",
        cursor: "9",
        limit: "2",
        // служебное от Vercel Protection и прочего транспорта
        "x-vercel-protection-bypass": "tok",
        _vercel_share: "abc",
        where: "1=1"
      })
    ).toEqual({ mode: "export", table: "Meal", cursor: "9", limit: "2" });
  });

  it("отсутствующие параметры не подставляются как undefined — работают дефолты", () => {
    expect(pickMigrationQuery({ foo: "bar" })).toEqual({});
    expect(migrationQuerySchema.parse(pickMigrationQuery({ foo: "bar" })).mode).toBe("counts");
  });

  it("не тянет ключи прототипа и переживает не-объект", () => {
    expect(pickMigrationQuery(Object.create({ table: "Meal" }))).toEqual({});
    expect(pickMigrationQuery(undefined)).toEqual({});
    expect(pickMigrationQuery(null)).toEqual({});
    expect(pickMigrationQuery("mode=counts")).toEqual({});
  });

  it("значения своих параметров не смягчаются — их по-прежнему судит строгая схема", () => {
    expect(migrationQuerySchema.safeParse(pickMigrationQuery({ mode: "export", table: "User;--" })).success).toBe(
      false
    );
    expect(
      migrationQuerySchema.safeParse(pickMigrationQuery({ mode: "export", table: "Meal", cursor: "x".repeat(129) }))
        .success
    ).toBe(false);
  });

  it("курсоры принимают только ключи ожидаемой формы", () => {
    expect(parseIntCursor(undefined)).toBeNull();
    expect(parseIntCursor("42")).toBe(42);
    expect(() => parseIntCursor("42; DROP TABLE")).toThrow(BadCursorError);
    expect(() => parseIntCursor("-1")).toThrow(BadCursorError);
    expect(parseBigIntCursor("9007199254740993")).toBe(9007199254740993n);
    expect(() => parseBigIntCursor("1.5")).toThrow(BadCursorError);
    expect(parseUsageCursor("7:2026-07-10")).toEqual({ userId: 7, date: "2026-07-10" });
    expect(() => parseUsageCursor("7:10.07.2026")).toThrow(BadCursorError);
  });
});

// --- Роут целиком, без базы: слой данных подменён ---

function fakeDeps(overrides: Partial<MigrationExportDeps> = {}): MigrationExportDeps {
  return {
    collectCounts: async () => ({ User: 2, Meal: 5, ProcessedUpdate: null }),
    fetchPage: async (): Promise<ExportPage> => ({
      rows: [{ id: 1, tgUserId: "9007199254740993", createdAt: "2026-07-10T08:30:00.000Z" }],
      nextCursor: null,
      available: true
    }),
    ...overrides
  };
}

async function buildTestApp(secret: string, deps: MigrationExportDeps = fakeDeps()) {
  const app = Fastify();
  registerMigrationExportRoutes(app, { secret, deps });
  await app.ready();
  return app;
}

const PATH = "/api/internal/migration-export";

describe("migration bridge: роут", () => {
  it("при пустом секрете роут не существует", async () => {
    const deps = fakeDeps();
    const spy = vi.spyOn(deps, "collectCounts");
    const app = await buildTestApp("", deps);
    const res = await app.inject({ method: "GET", url: `${PATH}?mode=counts` });
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it("без токена и с чужим токеном — 404 и никаких запросов к данным", async () => {
    const deps = fakeDeps();
    const spy = vi.spyOn(deps, "collectCounts");
    const app = await buildTestApp(SECRET, deps);

    const anon = await app.inject({ method: "GET", url: PATH });
    expect(anon.statusCode).toBe(404);
    expect(anon.headers["cache-control"]).toBe("private, no-store");

    const wrong = await app.inject({ method: "GET", url: PATH, headers: { authorization: "Bearer wrong" } });
    expect(wrong.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it("mode=counts отдаёт только счётчики", async () => {
    const app = await buildTestApp(SECRET);
    const res = await app.inject({
      method: "GET",
      url: `${PATH}?mode=counts`,
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json();
    expect(body).toEqual({
      mode: "counts",
      tables: { User: 2, Meal: 5, ProcessedUpdate: null },
      limits: { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }
    });
    expect(body).not.toHaveProperty("rows");
    await app.close();
  });

  it("mode=export отдаёт страницу строк с курсором", async () => {
    const seen: Array<[string, string | undefined, number]> = [];
    const deps = fakeDeps({
      fetchPage: async (table, cursor, limit) => {
        seen.push([table, cursor, limit]);
        return { rows: [{ id: 10 }, { id: 11 }], nextCursor: "11", available: true };
      }
    });
    const app = await buildTestApp(SECRET, deps);
    const res = await app.inject({
      method: "GET",
      url: `${PATH}?mode=export&table=Meal&cursor=9&limit=2`,
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: "export",
      table: "Meal",
      available: true,
      limit: 2,
      count: 2,
      nextCursor: "11",
      rows: [{ id: 10 }, { id: 11 }]
    });
    expect(seen).toEqual([["Meal", "9", 2]]);
    await app.close();
  });

  // Реальный protected Vercel Preview: прокси дописывает к запросу свои query-ключи,
  // из-за .strict() валидный запрос падал в 400 ещё до обращения к данным.
  it("служебные query-параметры транспорта игнорируются", async () => {
    const seen: Array<[string, string | undefined, number]> = [];
    const deps = fakeDeps({
      fetchPage: async (table, cursor, limit) => {
        seen.push([table, cursor, limit]);
        return { rows: [{ id: 10 }], nextCursor: null, available: true };
      }
    });
    const app = await buildTestApp(SECRET, deps);
    const auth = { authorization: `Bearer ${SECRET}` };

    // защищённый preview без единого нашего параметра — дефолтный mode=counts
    const bare = await app.inject({
      method: "GET",
      url: `${PATH}?x-vercel-protection-bypass=tok&_vercel_share=abc`,
      headers: auth
    });
    expect(bare.statusCode).toBe(200);
    expect(bare.json()).toEqual({
      mode: "counts",
      tables: { User: 2, Meal: 5, ProcessedUpdate: null },
      limits: { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }
    });

    const exported = await app.inject({
      method: "GET",
      url: `${PATH}?mode=export&table=Meal&cursor=9&limit=2&x-vercel-protection-bypass=tok&where=1%3D1`,
      headers: auth
    });
    expect(exported.statusCode).toBe(200);
    // чужие ключи не доехали ни до слоя данных, ни до ответа
    expect(seen).toEqual([["Meal", "9", 2]]);
    expect(JSON.stringify(exported.json())).not.toContain("vercel");
    expect(JSON.stringify(exported.json())).not.toContain("1=1");
    await app.close();
  });

  it("значения своих параметров всё так же проверяются, посторонние их не прикрывают", async () => {
    const deps = fakeDeps();
    const spy = vi.spyOn(deps, "fetchPage");
    const app = await buildTestApp(SECRET, deps);
    const auth = { authorization: `Bearer ${SECRET}` };

    const sqlTable = await app.inject({
      method: "GET",
      url: `${PATH}?mode=export&table=Meal%3B%20DROP%20TABLE%20%22User%22&x-vercel-protection-bypass=tok`,
      headers: auth
    });
    expect(sqlTable.statusCode).toBe(400);
    expect(sqlTable.json()).toEqual({ error: "bad_request" });

    const sqlCursor = await app.inject({
      method: "GET",
      url: `${PATH}?mode=export&table=Meal&cursor=${"x".repeat(129)}&_vercel_share=abc`,
      headers: auth
    });
    expect(sqlCursor.statusCode).toBe(400);

    const overLimit = await app.inject({
      method: "GET",
      url: `${PATH}?mode=export&table=Meal&limit=${MAX_LIMIT + 1}&_vercel_share=abc`,
      headers: auth
    });
    expect(overLimit.statusCode).toBe(400);

    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it("посторонние параметры не открывают эндпоинт без токена", async () => {
    const deps = fakeDeps();
    const spy = vi.spyOn(deps, "collectCounts");
    const app = await buildTestApp(SECRET, deps);
    const res = await app.inject({ method: "GET", url: `${PATH}?x-vercel-protection-bypass=tok` });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it("неверный запрос — 400, битый курсор — bad_cursor", async () => {
    const deps = fakeDeps({
      fetchPage: async () => {
        throw new BadCursorError("bad_cursor");
      }
    });
    const app = await buildTestApp(SECRET, deps);
    const auth = { authorization: `Bearer ${SECRET}` };

    const noTable = await app.inject({ method: "GET", url: `${PATH}?mode=export`, headers: auth });
    expect(noTable.statusCode).toBe(400);

    const unknown = await app.inject({ method: "GET", url: `${PATH}?mode=export&table=User;--`, headers: auth });
    expect(unknown.statusCode).toBe(400);

    const badCursor = await app.inject({
      method: "GET",
      url: `${PATH}?mode=export&table=User&cursor=oops`,
      headers: auth
    });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toEqual({ error: "bad_cursor" });
    await app.close();
  });
});
