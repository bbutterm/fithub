import type { User } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { bot } from "../bot/bot.js";
import { REMINDER_TEXT, reminderKeyboard } from "../bot/reminderCard.js";
import { localDateStr, zonedDayRangeUtc } from "../utils/tz.js";
import { shouldRemind } from "./schedule.js";

// Пользователей мало, а запросов на каждого два — бюджет небольшой; недошедшие
// получат напоминание на следующем тике, дубли отсекает lastReminderDate.
const DEFAULT_BUDGET_MS = 8_000;
const DAY_MS = 86_400_000;

function localHourOf(tz: string, now: Date): number {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(now));
  return Number.isFinite(h) ? h % 24 : 0;
}

async function remindOne(user: User, now: Date): Promise<void> {
  const today = localDateStr(user.tz, now);
  const localHour = localHourOf(user.tz, now);
  // Дешёвая отсечка до запросов в базу — правило целиком в shouldRemind.
  if (localHour < 17 || user.lastReminderDate === today) return;

  const { start } = zonedDayRangeUtc(today, user.tz);
  const [mealsToday, lastMeal] = await Promise.all([
    prisma.meal.count({ where: { userId: user.id, eatenAt: { gte: start } } }),
    prisma.meal.findFirst({ where: { userId: user.id }, orderBy: { eatenAt: "desc" }, select: { eatenAt: true } })
  ]);
  const go = shouldRemind({
    localHour,
    mealsToday,
    lastReminderDate: user.lastReminderDate,
    today,
    daysSinceLastMeal: lastMeal ? (now.getTime() - lastMeal.eatenAt.getTime()) / DAY_MS : null,
    daysSinceSignup: (now.getTime() - user.createdAt.getTime()) / DAY_MS
  });
  if (!go) return;

  // Сначала отметка, потом отправка: если функция умрёт между ними, человек
  // пропустит одно напоминание. Наоборот — получит два, а это хуже.
  await prisma.user.update({ where: { id: user.id }, data: { lastReminderDate: today } });
  await bot.api.sendMessage(Number(user.tgUserId), REMINDER_TEXT, { reply_markup: reminderKeyboard() });
  logger.info({ userId: user.id }, "evening reminder sent");
}

/** Вечернее «сегодня в дневнике пусто» тем, кто его не выключил. */
export async function runReminderTick(now: Date = new Date(), budgetMs = DEFAULT_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // Без профиля — значит, онбординг не пройден; таким напоминание нужно не меньше.
  const users = await prisma.user.findMany({
    where: { OR: [{ profile: null }, { profile: { reminderEnabled: true } }] }
  });
  let processed = 0;
  for (const user of users) {
    if (Date.now() > deadline) {
      logger.warn({ processed, total: users.length }, "reminder tick out of time, rest continues next tick");
      break;
    }
    await remindOne(user, now).catch((err) => logger.error({ err: String(err), userId: user.id }, "reminder failed"));
    processed += 1;
  }
}
