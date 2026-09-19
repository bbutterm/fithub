import type { MealSource } from "@prisma/client";
import { prisma } from "../db.js";
import { foodResponseSchema, type FoodRecognition } from "../ai/food.js";
import { createMealFromRecognition } from "./meals.js";
import { getDailyStats } from "./stats.js";
import { addDays, localDateStr } from "../utils/tz.js";

/**
 * Проверка «можно ли мне это?» без записи в дневник.
 *
 * Распознавание сохраняется на случай, если человек всё же нажмёт «Записать»:
 * повторно платить модели за то же фото не хочется, а в callback_data 64 байта.
 */
export async function saveQuickCheck(params: {
  userId: number;
  recognition: FoodRecognition;
  source: MealSource;
  photoFileId?: string;
  photoThumbFileId?: string;
  dietNote: string | null;
  dietVerdict: string | null;
}): Promise<number> {
  const row = await prisma.quickCheck.create({
    data: {
      userId: params.userId,
      recognition: JSON.parse(JSON.stringify(params.recognition)),
      source: params.source,
      photoFileId: params.photoFileId,
      photoThumbFileId: params.photoThumbFileId,
      dietNote: params.dietNote,
      dietVerdict: params.dietVerdict
    },
    select: { id: true }
  });
  return row.id;
}

/** Превратить проверку в запись дневника. null — проверки нет (чужая, устарела, уже записана). */
export async function logQuickCheck(id: number, userId: number) {
  const qc = await prisma.quickCheck.findFirst({ where: { id, userId } });
  if (!qc) return null;
  const parsed = foodResponseSchema.safeParse(qc.recognition);
  if (!parsed.success || parsed.data.items.length === 0) return null;

  const meal = await createMealFromRecognition({
    userId,
    recognition: parsed.data,
    source: qc.source,
    photoFileId: qc.photoFileId ?? undefined,
    photoThumbFileId: qc.photoThumbFileId ?? undefined
  });
  // Вердикт по режиму уже есть — переносим, а не считаем заново.
  const withDiet = qc.dietNote
    ? await prisma.meal.update({
        where: { id: meal.id },
        data: { dietNote: qc.dietNote, dietVerdict: qc.dietVerdict },
        include: { items: true }
      })
    : meal;
  await prisma.quickCheck.delete({ where: { id } }).catch(() => undefined);
  return withDiet;
}

/** Старые проверки никому не нужны: кнопка «Записать» через неделю — редкость. */
export async function purgeOldQuickChecks(olderThanDays = 7): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  await prisma.quickCheck.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(() => undefined);
}

/**
 * «Обычный день» пользователя: среднее по дням с записями за две недели до сегодня.
 * Меньше двух таких дней — среднего нет, честнее попросить фото.
 */
export async function usualDayEstimate(
  userId: number,
  tz: string
): Promise<{ kcal: number; protein: number; fat: number; carbs: number; days: number } | null> {
  const yesterday = addDays(localDateStr(tz), -1);
  const stats = await getDailyStats(userId, tz, 14, yesterday);
  const logged = stats.filter((s) => s.mealsCount > 0);
  if (logged.length < 2) return null;
  const avg = (pick: (s: (typeof logged)[number]) => number) =>
    Math.round(logged.reduce((sum, s) => sum + pick(s), 0) / logged.length);
  return {
    kcal: avg((s) => s.kcal),
    protein: avg((s) => s.protein),
    fat: avg((s) => s.fat),
    carbs: avg((s) => s.carbs),
    days: logged.length
  };
}
