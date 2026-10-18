import type { Context } from "grammy";
import type { Meal, MealItem } from "@prisma/client";
import { prisma } from "../db.js";
import { applyDietCheck } from "../services/diet.js";
import { getDay } from "../services/meals.js";
import { nextStepHint } from "../services/nextStep.js";
import { calcStreak, getDailyStats } from "../services/stats.js";
import { localDateStr } from "../utils/tz.js";
import { formatMealCard } from "./cards.js";
import { mealKeyboard } from "./keyboards.js";

export type MealWithItems = Meal & { items: MealItem[] };

/**
 * Собрать и отрисовать карточку приёма пищи.
 *
 * Последовательность «взять профиль и итоги дня → сверить с режимом питания →
 * отрисовать» была скопирована в трёх местах: фото, текст без контекста и текст
 * при наличии недавней записи. Из-за этого проверка режима однажды попала в две
 * точки из трёх. Теперь она одна.
 */
export async function renderMealCard(
  userId: number,
  tz: string,
  meal: MealWithItems,
  opts: { checkDiet?: boolean } = {}
): Promise<string> {
  const [profile, day, weekStats] = await Promise.all([
    prisma.profile.findUnique({ where: { userId } }),
    getDay(userId, localDateStr(tz), tz),
    getDailyStats(userId, tz, 14)
  ]);
  const checked = opts.checkDiet ? await applyDietCheck(meal, profile) : meal;
  const hourLocal = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())) % 24;
  return formatMealCard({
    meal: checked,
    dayKcal: day.totals.totalKcal,
    targetKcal: profile?.targetKcal ?? null,
    streak: calcStreak(weekStats),
    tz,
    nextStep: profile
      ? nextStepHint({
          hourLocal,
          dayKcal: day.totals.totalKcal,
          dayProtein: day.totals.totalProtein,
          targetKcal: profile.targetKcal,
          targetProtein: profile.targetProtein,
          dietType: profile.dietType
        })
      : null
  });
}

/**
 * Показать карточку только что созданного приёма в статус-сообщении и запомнить
 * его message_id: ответ на карточку = уточнение именно этой записи.
 */
export async function publishMealCard(
  ctx: Context,
  user: { id: number; tz: string },
  meal: MealWithItems,
  statusMessageId: number
): Promise<void> {
  if (!ctx.chat) return;
  const text = await renderMealCard(user.id, user.tz, meal, { checkDiet: true });
  await ctx.api.editMessageText(ctx.chat.id, statusMessageId, text, {
    parse_mode: "HTML",
    reply_markup: mealKeyboard(meal.id)
  });
  await prisma.meal
    .update({ where: { id: meal.id }, data: { tgMessageId: BigInt(statusMessageId) } })
    .catch(() => undefined);
}

/** Перерисовать карточку приёма (после смены времени/состава). */
export async function redrawMealCard(
  ctx: Context,
  userId: number,
  mealId: number,
  messageId: number,
  // Состав изменился — отметку о диете надо пересчитать, иначе она останется
  // от прошлых блюд. При смене только времени приёма пересчитывать незачем:
  // это лишний платный вызов с тем же результатом.
  opts: { recheckDiet?: boolean } = {}
): Promise<void> {
  if (!ctx.chat) return;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const meal = await prisma.meal.findFirst({ where: { id: mealId, userId }, include: { items: true } });
  if (!meal) return;
  const text = await renderMealCard(userId, user.tz, meal, { checkDiet: opts.recheckDiet });
  await ctx.api
    .editMessageText(ctx.chat.id, messageId, text, { parse_mode: "HTML", reply_markup: mealKeyboard(mealId) })
    .catch(() => undefined);
}

