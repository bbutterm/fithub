import { createHash } from "node:crypto";
import { z } from "zod";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(10, "BOT_TOKEN обязателен — получите у @BotFather"),
  DATABASE_URL: z.string().url("DATABASE_URL обязателен — PostgreSQL connection string"),
  WEBAPP_URL: z.string().url("WEBAPP_URL обязателен — публичный HTTPS URL Mini App"),

  TZ_DEFAULT: z.string().default("Europe/Moscow"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  JWT_SECRET: z.string().optional(),
  BOT_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  CRON_SECRET: z.string().optional().default(""),

  S3_ENDPOINT: z.string().optional().default(""),
  S3_ACCESS_KEY: z.string().optional().default(""),
  S3_SECRET_KEY: z.string().optional().default(""),
  S3_BUCKET: z.string().optional().default(""),

  // Vision-провайдер — только распознавание фото еды (OpenRouter, Qwen)
  VISION_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  VISION_API_KEY: z.string().min(5, "VISION_API_KEY обязателен — ключ vision-провайдера, https://openrouter.ai/keys"),
  VISION_MODEL: z.string().default("qwen/qwen3-vl-32b-instruct"),
  VISION_MODEL_FALLBACK: z.string().default("qwen/qwen3-vl-235b-a22b-instruct"),
  // Порог уверенности, ниже которого фото перепроверяется fallback-моделью (0 — никогда, 1 — всегда)
  VISION_FALLBACK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  // Расшифровка голосовых: модель с поддержкой аудио-входа у vision-провайдера (OpenRouter)
  AUDIO_MODEL: z.string().default("google/gemini-2.5-flash"),

  // Text-провайдер — советы, отчёты, текстовые описания еды (DeepSeek)
  TEXT_BASE_URL: z.string().url().default("https://api.deepseek.com/v1"),
  TEXT_API_KEY: z.string().min(5, "TEXT_API_KEY обязателен — ключ text-провайдера, https://platform.deepseek.com/api_keys"),
  TEXT_MODEL: z.string().default("deepseek-chat"),

  // Приём оплаты включается/выключается в коде — см. src/features.ts (PAYMENTS_ENABLED)
  STARS_PRICE_MONTH: z.coerce.number().int().positive().default(250),
  STARS_PRICE_YEAR: z.coerce.number().int().positive().default(1700),
  FREE_PHOTOS_PER_DAY: z.coerce.number().int().positive().default(3),

  // Админка: Telegram ID администраторов через запятую
  ADMIN_TG_IDS: z.string().optional().default(""),
  // Учёт расходов: курс и цены токенов (USD за 1M), если провайдер не сообщает стоимость сам
  USD_RUB_RATE: z.coerce.number().positive().default(90),
  PRICE_TEXT_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(0.28),
  PRICE_TEXT_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(0.42),
  PRICE_VISION_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(0.5),
  PRICE_VISION_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(1.5)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // DIRECT_URL нужен Prisma для миграций; в рантайме достаточно DATABASE_URL
  env.DIRECT_URL ??= env.DATABASE_URL;
  // Защита от копипасты: обрезаем пробелы и переводы строк во всех значениях
  // (случайный Enter в Vercel Environment Variables ломал имя модели → 400 от провайдера)
  const cleaned = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
  ) as NodeJS.ProcessEnv;
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`\n❌ Ошибка конфигурации (.env):\n${issues}\n\nСкопируйте .env.example в .env и заполните значения.\n`);
    process.exit(1);
  }
  const c = parsed.data;
  // Пустой CRON_SECRET = крон-эндпоинты открыты всему интернету: любой желающий
  // запускает рассылку советов и месячные отчёты за ваш счёт
  if (!c.CRON_SECRET) {
    console.warn(
      `\n⚠️  CRON_SECRET не задан — /api/cron/* принимает запросы без проверки.\n` +
        `   Задайте любую случайную строку в переменных окружения: Vercel подставит её\n` +
        `   в заголовок Authorization при вызове крона автоматически.\n`
    );
  }
  // Одна и та же модель по обе стороны каскада — самая незаметная утечка денег:
  // при низкой уверенности бот переспрашивает ту же модель и платит дважды за тот же ответ
  if (c.VISION_MODEL === c.VISION_MODEL_FALLBACK && c.VISION_FALLBACK_THRESHOLD > 0) {
    console.warn(
      `\n⚠️  VISION_MODEL и VISION_MODEL_FALLBACK совпадают (${c.VISION_MODEL}).\n` +
        `   Перепроверка при уверенности ниже ${c.VISION_FALLBACK_THRESHOLD} переспросит ту же модель и удвоит счёт.\n` +
        `   Укажите в VISION_MODEL_FALLBACK другую модель — или VISION_FALLBACK_THRESHOLD=0, чтобы отключить перепроверку.\n`
    );
  }
  return {
    ...c,
    BOT_WEBHOOK_URL: c.BOT_WEBHOOK_URL || undefined,
    // S3 включается только когда задан endpoint; иначе работаем через Telegram file_id + прокси
    s3Enabled: Boolean(c.S3_ENDPOINT),
    jwtSecret: c.JWT_SECRET || createHash("sha256").update(`${c.BOT_TOKEN}:jwt`).digest("hex"),
    // secret_token для проверки, что webhook-запросы приходят именно от Telegram
    webhookSecret: createHash("sha256").update(`${c.BOT_TOKEN}:webhook`).digest("hex"),
    adminTgIds: new Set(
      c.ADMIN_TG_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  };
}

export const config = loadConfig();
