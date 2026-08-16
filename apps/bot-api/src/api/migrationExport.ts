import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * ВРЕМЕННЫЙ мост для разового переноса базы (cloud Postgres → self-hosted).
 * Не продуктовая функция: включается только заданным MIGRATION_SECRET
 * (в Vercel — только в Preview), после переноса переменная и этот файл удаляются.
 *
 * Ответ Vercel-функции ограничен по размеру, поэтому выгрузка постраничная:
 * keyset-пагинация по первичному ключу, страницами по DEFAULT_LIMIT строк.
 */

/** Таблицы ядра. RecognitionLock не выгружается — эфемерные блокировки рантайма. */
export const MIGRATION_TABLES = [
  "User",
  "Profile",
  "Meal",
  "MealItem",
  "DailyAdvice",
  "Subscription",
  "UsageCounter",
  "AiUsage",
  // вне Prisma, создаётся лениво — выгружается, только если таблица уже существует
  "ProcessedUpdate"
] as const;

export type MigrationTable = (typeof MIGRATION_TABLES)[number];

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

export const migrationQuerySchema = z
  .object({
    mode: z.enum(["counts", "export"]).default("counts"),
    table: z.enum(MIGRATION_TABLES).optional(),
    cursor: z.string().max(128).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
  })
  .strict()
  .refine((q) => q.mode !== "export" || q.table !== undefined, { message: "table_required", path: ["table"] });

export type MigrationQuery = z.infer<typeof migrationQuerySchema>;

/** Параметры, которые эндпоинт вообще признаёт. Всё остальное в схему не попадает. */
const MIGRATION_QUERY_KEYS = ["mode", "table", "cursor", "limit"] as const;

/**
 * Оставляет из query только свои параметры.
 *
 * Vercel Protection (и прокси вообще) дописывают к защищённому запросу служебные
 * ключи транспорта — со .strict() они валили валидный запрос в 400. Неизвестные
 * ключи здесь отбрасываются целиком: дальше — ни в схему, ни в лог, ни в SQL,
 * ни в ответ — они не проходят. Значения не трогаем: их по-прежнему проверяет
 * прежняя строгая схема, поэтому `table=User;--` и битый cursor остаются 400.
 */
export function pickMigrationQuery(query: unknown): Record<string, unknown> {
  if (query === null || typeof query !== "object") return {};
  const source = query as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of MIGRATION_QUERY_KEYS) {
    // hasOwnProperty: ключи из прототипа — не параметры запроса
    if (Object.prototype.hasOwnProperty.call(source, key)) picked[key] = source[key];
  }
  return picked;
}

/** Сравнение секретов за постоянное время: хэши уравнивают длину, длина секрета не утекает. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Пустой секрет = мост выключен: авторизовать нечем, любой запрос неавторизован. */
export function isMigrationAuthorized(authorization: string | undefined, secret: string): boolean {
  if (!secret) return false;
  if (typeof authorization !== "string") return false;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  return constantTimeEqual(authorization.slice(prefix.length), secret);
}

/** BigInt → строка, Date → ISO; остальное рекурсивно (Json-поля, массивы). */
export function serializeExportValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeExportValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeExportValue(v)])
    );
  }
  return value;
}

export function serializeExportRow(row: Record<string, unknown>): Record<string, unknown> {
  return serializeExportValue(row) as Record<string, unknown>;
}

export class BadCursorError extends Error {}

/** Курсор целочисленного PK. */
export function parseIntCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === "") return null;
  if (!/^\d{1,15}$/.test(cursor)) throw new BadCursorError("bad_cursor");
  return Number(cursor);
}

/** Курсор BigInt-PK (ProcessedUpdate.updateId). */
export function parseBigIntCursor(cursor: string | undefined): bigint | null {
  if (cursor === undefined || cursor === "") return null;
  if (!/^\d{1,19}$/.test(cursor)) throw new BadCursorError("bad_cursor");
  return BigInt(cursor);
}

/** Курсор составного PK UsageCounter: "<userId>:<YYYY-MM-DD>". */
export function parseUsageCursor(cursor: string | undefined): { userId: number; date: string } | null {
  if (cursor === undefined || cursor === "") return null;
  const m = /^(\d{1,15}):(\d{4}-\d{2}-\d{2})$/.exec(cursor);
  const userId = m?.[1];
  const date = m?.[2];
  if (userId === undefined || date === undefined) throw new BadCursorError("bad_cursor");
  return { userId: Number(userId), date };
}

export type ExportPage = {
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
  /** null-таблицы (ленивый ProcessedUpdate) отдают available:false вместо ошибки */
  available: boolean;
};

type TableSpec = {
  /** null — таблицы ещё нет в базе */
  count: () => Promise<number | null>;
  page: (cursor: string | undefined, limit: number) => Promise<ExportPage>;
};

function pageOf(
  rows: Array<Record<string, unknown>>,
  limit: number,
  cursorOf: (row: Record<string, unknown>) => string
): ExportPage {
  const serialized = rows.map(serializeExportRow);
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return { rows: serialized, nextCursor: last ? cursorOf(last) : null, available: true };
}

/** Ленивая таблица дедупликации webhook-апдейтов: могла ещё не создаться. */
async function processedUpdateExists(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ reg: string | null }>>`SELECT to_regclass('"ProcessedUpdate"')::text AS reg`;
  return Boolean(rows[0]?.reg);
}

const TABLE_SPECS: Record<MigrationTable, TableSpec> = {
  User: {
    count: () => prisma.user.count(),
    page: async (cursor, limit) => {
      const after = parseIntCursor(cursor);
      const rows = await prisma.user.findMany({
        where: after === null ? undefined : { id: { gt: after } },
        orderBy: { id: "asc" },
        take: limit
      });
      return pageOf(rows, limit, (r) => String(r.id));
    }
  },
  Profile: {
    count: () => prisma.profile.count(),
    page: async (cursor, limit) => {
      const after = parseIntCursor(cursor);
      const rows = await prisma.profile.findMany({
        where: after === null ? undefined : { userId: { gt: after } },
        orderBy: { userId: "asc" },
        take: limit
      });
      return pageOf(rows, limit, (r) => String(r.userId));
    }
  },
  Meal: {
    count: () => prisma.meal.count(),
    page: async (cursor, limit) => {
      const after = parseIntCursor(cursor);
      const rows = await prisma.meal.findMany({
        where: after === null ? undefined : { id: { gt: after } },
        orderBy: { id: "asc" },
        take: limit
      });
      return pageOf(rows, limit, (r) => String(r.id));
    }
  },
  MealItem: {
    count: () => prisma.mealItem.count(),
    page: async (cursor, limit) => {
      const after = parseIntCursor(cursor);
      const rows = await prisma.mealItem.findMany({
        where: after === null ? undefined : { id: { gt: after } },
        orderBy: { id: "asc" },
        take: limit
      });
      return pageOf(rows, limit, (r) => String(r.id));
    }
  },
  DailyAdvice: {
    count: () => prisma.dailyAdvice.count(),
    page: async (cursor, limit) => {
      const after = parseIntCursor(cursor);
      const rows = await prisma.dailyAdvice.findMany({
        where: after === null ? undefined : { id: { gt: after } },
        orderBy: { id: "asc" },
        take: limit
      });
      return pageOf(rows, limit, (r) => String(r.id));
    }
  },
  Subscription: {
    count: () => prisma.subscription.count(),
    page: async (cursor, limit) => {
      const after = parseIntCursor(cursor);
      const rows = await prisma.subscription.findMany({
        where: after === null ? undefined : { id: { gt: after } },
        orderBy: { id: "asc" },
        take: limit
      });
      return pageOf(rows, limit, (r) => String(r.id));
    }
  },
  UsageCounter: {
    count: () => prisma.usageCounter.count(),
    page: async (cursor, limit) => {
      const after = parseUsageCursor(cursor);
      const rows = await prisma.usageCounter.findMany({
        where:
          after === null
            ? undefined
            : { OR: [{ userId: { gt: after.userId } }, { userId: after.userId, date: { gt: after.date } }] },
        orderBy: [{ userId: "asc" }, { date: "asc" }],
        take: limit
      });
      return pageOf(rows, limit, (r) => `${String(r.userId)}:${String(r.date)}`);
    }
  },
  AiUsage: {
    count: () => prisma.aiUsage.count(),
    page: async (cursor, limit) => {
      const after = parseIntCursor(cursor);
      const rows = await prisma.aiUsage.findMany({
        where: after === null ? undefined : { id: { gt: after } },
        orderBy: { id: "asc" },
        take: limit
      });
      return pageOf(rows, limit, (r) => String(r.id));
    }
  },
  ProcessedUpdate: {
    count: async () => {
      if (!(await processedUpdateExists())) return null;
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "ProcessedUpdate"`;
      return Number(rows[0]?.n ?? 0);
    },
    page: async (cursor, limit) => {
      const after = parseBigIntCursor(cursor);
      if (!(await processedUpdateExists())) return { rows: [], nextCursor: null, available: false };
      const rows =
        after === null
          ? await prisma.$queryRaw<Array<{ updateId: bigint; createdAt: Date }>>`
              SELECT "updateId", "createdAt" FROM "ProcessedUpdate" ORDER BY "updateId" ASC LIMIT ${limit}`
          : await prisma.$queryRaw<Array<{ updateId: bigint; createdAt: Date }>>`
              SELECT "updateId", "createdAt" FROM "ProcessedUpdate"
              WHERE "updateId" > ${after} ORDER BY "updateId" ASC LIMIT ${limit}`;
      return pageOf(rows, limit, (r) => String(r.updateId));
    }
  }
};

/** Все счётчики строк: ключ — имя таблицы, null — таблицы нет в базе. */
export async function collectCounts(): Promise<Record<string, number | null>> {
  const entries = await Promise.all(
    MIGRATION_TABLES.map(async (table) => [table, await TABLE_SPECS[table].count()] as const)
  );
  return Object.fromEntries(entries);
}

export async function fetchPage(table: MigrationTable, cursor: string | undefined, limit: number): Promise<ExportPage> {
  return TABLE_SPECS[table].page(cursor, limit);
}

/** Слой данных вынесен параметром — тесты проверяют роут без обращения к базе. */
export type MigrationExportDeps = {
  collectCounts: () => Promise<Record<string, number | null>>;
  fetchPage: (table: MigrationTable, cursor: string | undefined, limit: number) => Promise<ExportPage>;
};

/**
 * Регистрирует временный эндпоинт. При пустом MIGRATION_SECRET роут не создаётся
 * вовсе — путь отдаёт стандартный 404, как будто его нет.
 */
export function registerMigrationExportRoutes(
  app: FastifyInstance,
  options: { secret?: string; deps?: MigrationExportDeps } = {}
): void {
  const secret = options.secret ?? config.MIGRATION_SECRET;
  const deps = options.deps ?? { collectCounts, fetchPage };
  if (!secret) return;

  app.get("/api/internal/migration-export", async (request, reply) => {
    // без await: FastifyReply — thenable, ожидание reply вне send() подвешивает запрос
    reply.header("Cache-Control", "private, no-store");
    // Неавторизованный запрос не должен подтверждать существование эндпоинта
    if (!isMigrationAuthorized(request.headers.authorization, secret)) {
      return reply.code(404).send({ error: "not_found" });
    }

    const parsed = migrationQuerySchema.safeParse(pickMigrationQuery(request.query));
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const q = parsed.data;

    try {
      if (q.mode === "counts") {
        return {
          mode: "counts",
          tables: await deps.collectCounts(),
          limits: { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }
        };
      }
      const table = q.table;
      if (!table) return reply.code(400).send({ error: "bad_request" });
      const page = await deps.fetchPage(table, q.cursor, q.limit);
      return {
        mode: "export",
        table,
        available: page.available,
        limit: q.limit,
        count: page.rows.length,
        nextCursor: page.nextCursor,
        rows: page.rows
      };
    } catch (err) {
      if (err instanceof BadCursorError) return reply.code(400).send({ error: "bad_cursor" });
      // Логируем только тип ошибки: ни данных, ни секрета в лог не попадает
      logger.error({ table: q.table, kind: err instanceof Error ? err.name : "unknown" }, "migration export failed");
      return reply.code(500).send({ error: "export_failed" });
    }
  });
}
