/**
 * Описание таблиц ядра FitHub для разового импорта cloud-выгрузки.
 *
 * Единственный источник правды об именах таблиц, колонок и их типах — этот файл;
 * он собран вручную по apps/bot-api/prisma/schema.prisma (включая служебную
 * "ProcessedUpdate": BIGINT PK + TIMESTAMPTZ).
 *
 * ВАЖНО про соседний продукт: в той же базе живут таблицы B Plus, они пишутся
 * строчными буквами. Здесь перечислены только таблицы FitHub в кавычках и с
 * CamelCase-именами; ни одно имя таблицы не приходит извне (ни из CLI, ни из
 * манифеста) — см. assertKnownTable(). Строчные имена импортёру недоступны в принципе.
 */

/** Тип значения колонки: определяет, как строка выгрузки превращается в значение для БД. */
export type ColumnKind =
  | "int"
  | "bigint"
  | "float"
  | "decimal"
  | "bool"
  | "string"
  | "stringArray"
  | "dateTime"
  | "dateOnly"
  | "json"
  | "enum";

export type ColumnSpec = {
  name: string;
  kind: ColumnKind;
  /** true — колонка допускает NULL (и может отсутствовать в строке выгрузки). */
  nullable?: boolean;
  /** Только для kind === "enum": допустимые значения Postgres-энума. */
  enumValues?: readonly string[];
};

export type ForeignKeySpec = {
  column: string;
  table: CoreTable;
  /** Колонка родителя, на которую ссылаемся (всегда первичный ключ). */
  references: string;
};

export type TableSpec = {
  columns: readonly ColumnSpec[];
  /** Первичный ключ: одна или несколько колонок (UsageCounter — составной). */
  pk: readonly string[];
  /** Колонка с autoincrement: после вставки явных id нужен setval для sequence. */
  serialColumn?: string;
  foreignKeys?: readonly ForeignKeySpec[];
};

/**
 * Таблицы ядра в порядке зависимостей: родитель всегда раньше потомка.
 * Порядок совпадает с MIGRATION_TABLES в мосте выгрузки (без ProcessedUpdate).
 */
export const CORE_TABLES = [
  "User",
  "Profile",
  "Meal",
  "MealItem",
  "DailyAdvice",
  "Subscription",
  "UsageCounter",
  "AiUsage"
] as const;

export type CoreTable = (typeof CORE_TABLES)[number];

/**
 * Таблица дедупликации webhook-апдейтов. Модель Prisma у неё есть, но импортёр пишет в
 * неё сырым SQL (своих id-sequence нет, состав колонок фиксирован) — поэтому отдельно от CORE_TABLES.
 */
export const PROCESSED_UPDATE_TABLE = "ProcessedUpdate";

/** Полный список таблиц, которые импортёр вообще может назвать в SQL. */
export const IMPORTABLE_TABLES = [...CORE_TABLES, PROCESSED_UPDATE_TABLE] as const;

export type ImportableTable = (typeof IMPORTABLE_TABLES)[number];

/**
 * RecognitionLock не переносится: эфемерные блокировки распознавания, после
 * переезда они не нужны и в выгрузке отсутствуют. Имя оставлено явно, чтобы
 * появление файла RecognitionLock.json в каталоге читалось как «лишний файл»,
 * а не как забытая таблица.
 */
export const NOT_MIGRATED_TABLES = ["RecognitionLock"] as const;

const GENDER = ["male", "female"] as const;
const ACTIVITY_LEVEL = ["sedentary", "light", "moderate", "high"] as const;
const GOAL = ["lose", "maintain", "gain"] as const;
const DIET_TYPE = ["none", "vegetarian", "vegan", "keto", "halal"] as const;
const ADVICE_TONE = ["strict", "friendly", "scientific"] as const;
const MEAL_SOURCE = ["photo", "text", "manual"] as const;
const ADVICE_KIND = ["daily", "monthly"] as const;
const PLAN = ["free", "pro"] as const;
const SUBSCRIPTION_STATUS = ["active", "expired", "canceled"] as const;

export const CORE_TABLE_SPECS: Record<CoreTable, TableSpec> = {
  User: {
    pk: ["id"],
    serialColumn: "id",
    columns: [
      { name: "id", kind: "int" },
      { name: "tgUserId", kind: "bigint" },
      { name: "firstName", kind: "string", nullable: true },
      { name: "username", kind: "string", nullable: true },
      { name: "tz", kind: "string" },
      { name: "createdAt", kind: "dateTime" },
      { name: "dailyLimitOverride", kind: "int", nullable: true }
    ]
  },
  Profile: {
    // userId — первичный ключ и одновременно ссылка на User, своей sequence нет
    pk: ["userId"],
    foreignKeys: [{ column: "userId", table: "User", references: "id" }],
    columns: [
      { name: "userId", kind: "int" },
      { name: "gender", kind: "enum", enumValues: GENDER },
      { name: "birthYear", kind: "int", nullable: true },
      { name: "heightCm", kind: "int", nullable: true },
      { name: "weightKg", kind: "float", nullable: true },
      { name: "activityLevel", kind: "enum", enumValues: ACTIVITY_LEVEL },
      { name: "goal", kind: "enum", enumValues: GOAL },
      { name: "dietType", kind: "enum", enumValues: DIET_TYPE },
      { name: "allergies", kind: "stringArray" },
      { name: "dislikes", kind: "stringArray" },
      { name: "targetKcal", kind: "int", nullable: true },
      { name: "targetProtein", kind: "int", nullable: true },
      { name: "targetFat", kind: "int", nullable: true },
      { name: "targetCarbs", kind: "int", nullable: true },
      { name: "adviceTone", kind: "enum", enumValues: ADVICE_TONE },
      { name: "adviceTime", kind: "string" },
      { name: "adviceEnabled", kind: "bool" },
      // @updatedAt: импортируем исходное значение как есть, «сейчас» тут неверно
      { name: "updatedAt", kind: "dateTime" }
    ]
  },
  Meal: {
    pk: ["id"],
    serialColumn: "id",
    foreignKeys: [{ column: "userId", table: "User", references: "id" }],
    columns: [
      { name: "id", kind: "int" },
      { name: "userId", kind: "int" },
      { name: "photoFileId", kind: "string", nullable: true },
      { name: "photoThumbFileId", kind: "string", nullable: true },
      { name: "photoS3Key", kind: "string", nullable: true },
      { name: "tgMessageId", kind: "bigint", nullable: true },
      { name: "eatenAt", kind: "dateTime" },
      { name: "totalKcal", kind: "float" },
      { name: "totalProtein", kind: "float" },
      { name: "totalFat", kind: "float" },
      { name: "totalCarbs", kind: "float" },
      { name: "aiComment", kind: "string", nullable: true },
      { name: "overallConfidence", kind: "float", nullable: true },
      { name: "source", kind: "enum", enumValues: MEAL_SOURCE }
    ]
  },
  MealItem: {
    pk: ["id"],
    serialColumn: "id",
    foreignKeys: [{ column: "mealId", table: "Meal", references: "id" }],
    columns: [
      { name: "id", kind: "int" },
      { name: "mealId", kind: "int" },
      { name: "dish", kind: "string" },
      { name: "grams", kind: "float" },
      { name: "kcal", kind: "float" },
      { name: "protein", kind: "float" },
      { name: "fat", kind: "float" },
      { name: "carbs", kind: "float" },
      { name: "confidence", kind: "float" }
    ]
  },
  DailyAdvice: {
    pk: ["id"],
    serialColumn: "id",
    foreignKeys: [{ column: "userId", table: "User", references: "id" }],
    columns: [
      { name: "id", kind: "int" },
      { name: "userId", kind: "int" },
      // в схеме это String (локальная дата пользователя), но формат строго YYYY-MM-DD
      { name: "date", kind: "dateOnly" },
      { name: "kind", kind: "enum", enumValues: ADVICE_KIND },
      { name: "adviceText", kind: "string" },
      { name: "statsJson", kind: "json" },
      { name: "createdAt", kind: "dateTime" }
    ]
  },
  Subscription: {
    pk: ["id"],
    serialColumn: "id",
    foreignKeys: [{ column: "userId", table: "User", references: "id" }],
    columns: [
      { name: "id", kind: "int" },
      { name: "userId", kind: "int" },
      { name: "plan", kind: "enum", enumValues: PLAN },
      { name: "status", kind: "enum", enumValues: SUBSCRIPTION_STATUS },
      { name: "startedAt", kind: "dateTime" },
      { name: "expiresAt", kind: "dateTime" },
      { name: "starsPaymentId", kind: "string", nullable: true }
    ]
  },
  UsageCounter: {
    // составной первичный ключ, sequence нет
    pk: ["userId", "date"],
    foreignKeys: [{ column: "userId", table: "User", references: "id" }],
    columns: [
      { name: "userId", kind: "int" },
      { name: "date", kind: "dateOnly" },
      { name: "photoCount", kind: "int" }
    ]
  },
  AiUsage: {
    pk: ["id"],
    serialColumn: "id",
    // userId nullable (onDelete: SetNull) — ссылку проверяем только у непустых значений
    foreignKeys: [{ column: "userId", table: "User", references: "id" }],
    columns: [
      { name: "id", kind: "int" },
      { name: "userId", kind: "int", nullable: true },
      { name: "client", kind: "string" },
      { name: "model", kind: "string" },
      { name: "purpose", kind: "string" },
      { name: "promptTokens", kind: "int" },
      { name: "completionTokens", kind: "int" },
      { name: "costUsd", kind: "float" },
      { name: "createdAt", kind: "dateTime" }
    ]
  }
};

/** ProcessedUpdate: BIGINT PRIMARY KEY + TIMESTAMPTZ, без sequence. */
export const PROCESSED_UPDATE_SPEC: TableSpec = {
  pk: ["updateId"],
  columns: [
    { name: "updateId", kind: "bigint" },
    { name: "createdAt", kind: "dateTime" }
  ]
};

export function specOf(table: ImportableTable): TableSpec {
  return table === PROCESSED_UPDATE_TABLE ? PROCESSED_UPDATE_SPEC : CORE_TABLE_SPECS[table];
}

export function isCoreTable(name: string): name is CoreTable {
  return (CORE_TABLES as readonly string[]).includes(name);
}

export function isImportableTable(name: string): name is ImportableTable {
  return (IMPORTABLE_TABLES as readonly string[]).includes(name);
}

export class UnknownTableError extends Error {}

/**
 * Единственная точка, через которую имя таблицы попадает в SQL.
 * Всё, что не входит в белый список FitHub (включая строчные таблицы B Plus),
 * отбрасывается с ошибкой — импортёр физически не может обратиться к чужой таблице.
 */
export function assertKnownTable(name: string): ImportableTable {
  if (!isImportableTable(name)) {
    throw new UnknownTableError(`таблица вне списка FitHub: ${JSON.stringify(name)}`);
  }
  return name;
}
