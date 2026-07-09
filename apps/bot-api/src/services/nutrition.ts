import type { ActivityLevel, Goal } from "@prisma/client";

export interface NormsInput {
  gender: "male" | "female";
  birthYear: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
}

export interface Norms {
  targetKcal: number;
  targetProtein: number;
  targetFat: number;
  targetCarbs: number;
}

const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  high: 1.725
};

const GOAL_FACTOR: Record<Goal, number> = {
  lose: 0.85, // −15%
  maintain: 1,
  gain: 1.1 // +10%
};

/** Нормы КБЖУ по Миффлину-Сан Жеору с коэффициентом активности и корректировкой под цель. */
export function calcNorms(input: NormsInput, now: Date = new Date()): Norms {
  const age = Math.max(10, now.getUTCFullYear() - input.birthYear);
  const base =
    10 * input.weightKg + 6.25 * input.heightCm - 5 * age + (input.gender === "male" ? 5 : -161);
  const tdee = base * ACTIVITY_FACTOR[input.activityLevel];
  const targetKcal = Math.round(tdee * GOAL_FACTOR[input.goal]);

  const proteinPerKg = input.goal === "lose" ? 1.8 : 1.6;
  const targetProtein = Math.round(input.weightKg * proteinPerKg);
  const targetFat = Math.max(50, Math.round(input.weightKg * 0.9));
  const targetCarbs = Math.max(0, Math.round((targetKcal - targetProtein * 4 - targetFat * 9) / 4));

  return { targetKcal, targetProtein, targetFat, targetCarbs };
}

/** Пропорциональный пересчёт КБЖУ позиции при изменении граммов. */
export function scaleItem(
  item: { grams: number; kcal: number; protein: number; fat: number; carbs: number },
  newGrams: number
): { grams: number; kcal: number; protein: number; fat: number; carbs: number } {
  const k = item.grams > 0 ? newGrams / item.grams : 0;
  const r = (v: number) => Math.round(v * k * 10) / 10;
  return { grams: newGrams, kcal: r(item.kcal), protein: r(item.protein), fat: r(item.fat), carbs: r(item.carbs) };
}

export function sumItems(items: Array<{ kcal: number; protein: number; fat: number; carbs: number }>) {
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    totalKcal: r(items.reduce((s, i) => s + i.kcal, 0)),
    totalProtein: r(items.reduce((s, i) => s + i.protein, 0)),
    totalFat: r(items.reduce((s, i) => s + i.fat, 0)),
    totalCarbs: r(items.reduce((s, i) => s + i.carbs, 0))
  };
}
