import type { prisma } from "../db.js";
import { signPhotoToken } from "../auth/photoToken.js";
import { itemsOf, type getRecipeForUser } from "../services/recipes.js";

/** Приведение записей базы к виду, который ждёт Mini App. */
export function serializeProfile(p: NonNullable<Awaited<ReturnType<typeof prisma.profile.findUnique>>>) {
  return { ...p, updatedAt: p.updatedAt.toISOString() };
}

export function serializeMeal(m: {
  id: number;
  userId?: number;
  photoThumbFileId?: string | null;
  eatenAt: Date;
  totalKcal: number;
  totalProtein: number;
  totalFat: number;
  totalCarbs: number;
  aiComment: string | null;
  overallConfidence: number | null;
  source: string;
  photoFileId: string | null;
  items: Array<{ id: number; dish: string; grams: number; kcal: number; protein: number; fat: number; carbs: number; confidence: number }>;
}) {
  return {
    id: m.id,
    eatenAt: m.eatenAt.toISOString(),
    totalKcal: m.totalKcal,
    totalProtein: m.totalProtein,
    totalFat: m.totalFat,
    totalCarbs: m.totalCarbs,
    aiComment: m.aiComment,
    overallConfidence: m.overallConfidence,
    source: m.source,
    hasPhoto: Boolean(m.photoFileId),
    // Подпись выдаётся вместе с приёмом: Mini App не собирает адрес картинки
    // из сессионного токена, а просто подставляет её
    photoToken: m.photoFileId && m.userId !== undefined ? signPhotoToken(m.id, m.userId) : null,
    items: m.items
  };
}

/**
 * waitUntil из request context Vercel (тот же механизм, что в @vercel/functions):
 * позволяет продолжить работу после отправки HTTP-ответа. Доступен не во всех
 * рантаймах — если его нет, webhook обрабатывается синхронно.
 */

export const serializeRecipe = (r: Awaited<ReturnType<typeof getRecipeForUser>>) =>
    r && {
      id: r.id,
      name: r.name,
      portionGrams: r.portionGrams,
      kcal: r.kcal,
      protein: r.protein,
      fat: r.fat,
      carbs: r.carbs,
      items: itemsOf(r),
      timesUsed: r.timesUsed,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null
    };
