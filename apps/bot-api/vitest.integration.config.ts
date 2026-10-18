import { defineConfig } from "vitest/config";

/**
 * Тесты, которым нужна настоящая база: маршруты API, сервисы, обработчики бота.
 *
 * Вынесены в отдельный конфиг, чтобы `pnpm test` оставался быстрым и работал
 * без PostgreSQL, а CI гонял оба набора. База берётся из TEST_DATABASE_URL —
 * отдельная переменная, чтобы случайный запуск не очистил рабочую базу.
 */
const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/bote2e";

export default defineConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    setupFiles: ["src/__tests__/integration/setup.ts"],
    // Один общий экземпляр базы: параллельные файлы чистили бы данные друг друга
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      BOT_TOKEN: "1234567890:TESTTOKENTESTTOKEN",
      VISION_API_KEY: "test-vision-key",
      TEXT_API_KEY: "test-text-key",
      WEBAPP_URL: "https://example.com",
      CRON_SECRET: "test-cron-secret",
      ADMIN_TG_IDS: "777001",
      LOG_LEVEL: "silent",
      DATABASE_URL: url,
      DIRECT_URL: url
    }
  }
});
