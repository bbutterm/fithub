import { describe, expect, it } from "vitest";
import { calcNorms, scaleItem, sumItems } from "../services/nutrition.js";

const now = new Date("2026-07-09T00:00:00Z");

describe("calcNorms (Миффлин-Сан Жеор)", () => {
  it("мужчина 34 лет, 180 см, 82 кг, умеренная активность, похудение", () => {
    const n = calcNorms(
      { gender: "male", birthYear: 1992, heightCm: 180, weightKg: 82, activityLevel: "moderate", goal: "lose" },
      now
    );
    // BMR = 10*82 + 6.25*180 - 5*34 + 5 = 1780; TDEE = 1780*1.55 = 2759; −15% ≈ 2345
    expect(n.targetKcal).toBe(2345);
    expect(n.targetProtein).toBe(Math.round(82 * 1.8));
    expect(n.targetFat).toBe(Math.round(82 * 0.9));
    expect(n.targetCarbs).toBeGreaterThan(100);
  });

  it("женщина: формула с −161 и надбавка +10% при наборе", () => {
    const maintain = calcNorms(
      { gender: "female", birthYear: 1996, heightCm: 165, weightKg: 60, activityLevel: "light", goal: "maintain" },
      now
    );
    const gain = calcNorms(
      { gender: "female", birthYear: 1996, heightCm: 165, weightKg: 60, activityLevel: "light", goal: "gain" },
      now
    );
    expect(gain.targetKcal).toBe(Math.round((maintain.targetKcal * 1.1) / 1) );
    // BMR = 600 + 1031.25 - 150 - 161 = 1320.25; TDEE = 1815.3 ≈ 1815
    expect(maintain.targetKcal).toBe(1815);
  });
});

describe("scaleItem — пропорциональный пересчёт", () => {
  it("удвоение граммов удваивает КБЖУ", () => {
    const scaled = scaleItem({ grams: 100, kcal: 200, protein: 10, fat: 5, carbs: 30 }, 200);
    expect(scaled).toEqual({ grams: 200, kcal: 400, protein: 20, fat: 10, carbs: 60 });
  });

  it("нулевые исходные граммы не дают деления на ноль", () => {
    const scaled = scaleItem({ grams: 0, kcal: 100, protein: 1, fat: 1, carbs: 1 }, 50);
    expect(scaled.kcal).toBe(0);
  });
});

describe("sumItems", () => {
  it("суммирует и округляет до 0.1", () => {
    const t = sumItems([
      { kcal: 100.25, protein: 10.11, fat: 5.55, carbs: 20 },
      { kcal: 200, protein: 20, fat: 10, carbs: 40.04 }
    ]);
    expect(t.totalKcal).toBe(300.3);
    expect(t.totalProtein).toBe(30.1);
    expect(t.totalFat).toBe(15.6);
    expect(t.totalCarbs).toBe(60);
  });
});
