import { describe, expect, it } from "vitest";
import { resolveRoute } from "../lib/route";

const url = (q = "") => `https://app.example.com/${q}`;

describe("куда открыть приложение", () => {
  it("без параметров — «Сегодня»", () => {
    expect(resolveRoute(url(), undefined)).toEqual({ tab: "today" });
  });

  it("известный экран открывается из адреса и из start_param", () => {
    expect(resolveRoute(url("?screen=settings"), undefined)).toEqual({ tab: "settings" });
    expect(resolveRoute(url(), "challenges")).toEqual({ tab: "challenges" });
  });

  it("ссылка на приём пищи открывает дневник с этим приёмом", () => {
    expect(resolveRoute(url("?meal=42"), undefined)).toEqual({ tab: "today", mealId: 42 });
    expect(resolveRoute(url(), "meal_42")).toEqual({ tab: "today", mealId: 42 });
  });

  it("мусор в параметрах не ломает экран", () => {
    expect(resolveRoute(url("?screen=../../etc/passwd"), undefined)).toEqual({ tab: "today" });
    expect(resolveRoute(url("?meal=abc"), undefined)).toEqual({ tab: "today" });
    expect(resolveRoute(url(), "ch_ABC123")).toEqual({ tab: "today" });
  });
});
