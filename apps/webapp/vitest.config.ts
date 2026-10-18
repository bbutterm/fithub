import { defineConfig } from "vitest/config";

// Тесты Mini App: только чистая логика (маршрут, гонки запросов, кэш вкладок),
// поэтому окружение node — jsdom сюда не нужен.
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node"
  }
});
