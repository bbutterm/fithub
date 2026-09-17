import type { Meal, MealItem, Profile } from "@prisma/client";
import { prisma } from "../db.js";
import { checkMealAgainstDiet } from "../ai/dietCheck.js";

type MealWithItems = Meal & { items: MealItem[] };

/**
 * Сверяет приём пищи с режимом питания и сохраняет отметку в записи.
 *
 * Возвращает приём с уже проставленной отметкой, чтобы карточку можно было
 * отрисовать сразу, не перечитывая запись из базы. Если режим не задан или
 * проверка не удалась, приём возвращается без изменений — карточка выйдет
 * такой же, как до появления этой функции.
 */
export async function applyDietCheck(meal: MealWithItems, profile: Profile | null): Promise<MealWithItems> {
  const verdict = await checkMealAgainstDiet({
    dishes: meal.items.map((i) => `${i.dish} — ${Math.round(i.grams)} г`),
    profile,
    userId: meal.userId
  });
  if (!verdict) return meal;

  await prisma.meal
    .update({ where: { id: meal.id }, data: { dietNote: verdict.note, dietVerdict: verdict.verdict } })
    .catch(() => undefined);
  return { ...meal, dietNote: verdict.note, dietVerdict: verdict.verdict };
}
