import { defineConfig } from "vitest/config";

// Тестовые значения env, чтобы pnpm test работал без настоящего .env
export default defineConfig({
  test: {
    // Только быстрые тесты чистых функций. Тесты с базой лежат в подпапке
    // integration и гоняются отдельным конфигом: иначе `pnpm test` требовал бы
    // поднятый PostgreSQL на каждой машине.
    include: ["src/__tests__/*.test.ts", "eval/__tests__/*.test.ts"],
    env: {
      BOT_TOKEN: "1234567890:TESTTOKENTESTTOKEN",
      VISION_API_KEY: "test-vision-key",
      TEXT_API_KEY: "test-text-key",
      DATABASE_URL: "postgresql://fithub:fithub@localhost:5432/fithub",
      WEBAPP_URL: "https://example.com"
    }
  }
});
