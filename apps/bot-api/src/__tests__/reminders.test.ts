import { describe, expect, it } from "vitest";
import { shouldRemind } from "../cron/schedule.js";

const base = { localHour: 21, mealsToday: 0, lastReminderDate: null, today: "2026-09-19", daysSinceLastMeal: 2, daysSinceSignup: 30 };

describe("shouldRemind", () => {
  it("вечером, день пуст, человек активен — шлём", () => {
    expect(shouldRemind(base)).toBe(true);
  });
  it("днём не шлём", () => {
    expect(shouldRemind({ ...base, localHour: 14 })).toBe(false);
  });
  it("есть записи — не шлём", () => {
    expect(shouldRemind({ ...base, mealsToday: 1 })).toBe(false);
  });
  it("сегодня уже слали — не дублируем", () => {
    expect(shouldRemind({ ...base, lastReminderDate: "2026-09-19" })).toBe(false);
    expect(shouldRemind({ ...base, lastReminderDate: "2026-09-18" })).toBe(true);
  });
  it("бросившим давно не шлём, новичкам без записей — шлём", () => {
    expect(shouldRemind({ ...base, daysSinceLastMeal: 20 })).toBe(false);
    expect(shouldRemind({ ...base, daysSinceLastMeal: null })).toBe(false);
    expect(shouldRemind({ ...base, daysSinceLastMeal: null, daysSinceSignup: 1 })).toBe(true);
  });
});
