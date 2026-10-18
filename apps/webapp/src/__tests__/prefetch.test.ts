import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Prefetch from "../prefetch";

// Загрузчики вкладок ходят в api — подменяем, чтобы считать запросы.
const recipes = vi.fn(async () => ({ recipes: [] }));
const challenges = vi.fn(async () => ({ active: null }));
vi.mock("../api", () => ({ api: { recipes: () => recipes(), challenges: () => challenges() } }));

let prefetch: typeof Prefetch;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules(); // модуль хранит кэш в себе — каждому тесту нужен чистый
  prefetch = await import("../prefetch");
});

describe("предзагрузка вкладок", () => {
  it("второй запрос берётся из кэша, а не из сети", async () => {
    await prefetch.load("recipes");
    await prefetch.load("recipes");
    expect(recipes).toHaveBeenCalledTimes(1);
  });

  it("параллельные запросы схлопываются в один", async () => {
    await Promise.all([prefetch.load("recipes"), prefetch.load("recipes"), prefetch.load("recipes")]);
    expect(recipes).toHaveBeenCalledTimes(1);
  });

  it("сброс кэша и запрос «свежего» снова идут в сеть", async () => {
    await prefetch.load("recipes");
    prefetch.invalidate("recipes");
    await prefetch.load("recipes");
    expect(recipes).toHaveBeenCalledTimes(2);

    await prefetch.load("recipes", true);
    expect(recipes).toHaveBeenCalledTimes(3);
  });

  it("до загрузки заглянуть в кэш нечего, после — есть", async () => {
    expect(prefetch.peek("recipes")).toBeUndefined();
    await prefetch.load("recipes");
    expect(prefetch.peek("recipes")).toEqual({ recipes: [] });
  });

  it("неудачная загрузка не кэшируется и не роняет прогрев", async () => {
    recipes.mockRejectedValueOnce(new Error("offline"));
    await expect(prefetch.load("recipes")).rejects.toThrow("offline");
    expect(prefetch.peek("recipes")).toBeUndefined();

    prefetch.warm();
    await Promise.resolve();
    expect(recipes).toHaveBeenCalledTimes(2);
    expect(challenges).toHaveBeenCalledTimes(1);
  });
});
