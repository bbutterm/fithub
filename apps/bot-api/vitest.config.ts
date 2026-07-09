import { defineConfig } from "vitest/config";

// Тестовые значения env, чтобы pnpm test работал без настоящего .env
export default defineConfig({
  test: {
    env: {
      BOT_TOKEN: "1234567890:TESTTOKENTESTTOKEN",
      VISION_API_KEY: "test-vision-key",
      TEXT_API_KEY: "test-text-key",
      DATABASE_URL: "postgresql://fithub:fithub@localhost:5432/fithub",
      WEBAPP_URL: "https://example.com"
    }
  }
});
