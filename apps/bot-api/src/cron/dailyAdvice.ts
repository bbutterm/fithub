import type { Profile, User } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { bot } from "../bot/bot.js";
import { textClient } from "../lib/ai.js";
import { buildDailyAdvicePrompt } from "../prompts/advice.js";
import { formatProfileBlock, formatStatsBlock, formatYesterdayBlock, getDailyStats } from "../services/stats.js";
import { getPlan } from "../services/subscription.js";
import { addDays, localDateStr, localTimeStr } from "../utils/tz.js";
import { chunk } from "./schedule.js";

// Free-тариф: укороченный совет 2 раза в неделю (понедельник и четверг)
const FREE_ADVICE_WEEKDAYS = new Set(["Mon", "Thu"]);

function localWeekday(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
}

// Один вызов ИИ занимает секунды, а serverless-функцию убивают на 60-й — поэтому
// пользователи обрабатываются пачками параллельно и с запасом по времени.
// Недошедшие получат совет на следующем тике: дубли исключает уникальный ключ DailyAdvice.
const CONCURRENCY = 5;
// Бюджет по умолчанию — для одиночного вызова. Общий почасовой эндпоинт
// передаёт свой, меньший: в одну функцию Vercel укладываются оба тика.
const DEFAULT_BUDGET_MS = 45_000;

/**
 * За какую дату слать совет этому пользователю прямо сейчас — или null.
 *
 * Тик запускается не обязательно часто: на бесплатном тарифе крон может быть
 * всего раз в сутки. Если смотреть только на сегодня, человек с adviceTime
 * позже часа запуска не получит совет НИКОГДА — на следующем тике повторится
 * та же проверка. Поэтому подхватываем и вчерашний пропуск: за один тик уходит
 * максимум один совет, и при любой частоте крона человек получает его раз в день.
 */
async function adviceDateFor(profile: Profile & { user: User }, now: Date): Promise<string | null> {
  const { user } = profile;
  const today = localDateStr(user.tz, now);
  const timePassedToday = localTimeStr(user.tz, now) >= profile.adviceTime;

  const sent = await prisma.dailyAdvice.findMany({
    where: { userId: user.id, kind: "daily", date: { in: [today, addDays(today, -1)] } },
    select: { date: true }
  });
  const has = (d: string) => sent.some((r) => r.date === d);

  if (timePassedToday && !has(today)) return today;
  // Вчерашнее время прошло по определению — если совета за вчера нет, шлём его
  const yesterday = addDays(today, -1);
  if (!has(yesterday)) return yesterday;
  return null;
}

/** Совет одному пользователю. Бросает исключение — вызывающий логирует и идёт дальше. */
async function sendDailyAdvice(profile: Profile & { user: User }, now: Date): Promise<void> {
  const { user } = profile;
  const today = await adviceDateFor(profile, now);
  if (!today) return;

  const plan = await getPlan(user.id);
  if (plan === "free" && !FREE_ADVICE_WEEKDAYS.has(localWeekday(user.tz, now))) return;

  const stats = await getDailyStats(user.id, user.tz, 7, today);
  if (stats.every((s) => s.mealsCount === 0)) return; // нечего анализировать

  const prompt = buildDailyAdvicePrompt({
    tone: profile.adviceTone,
    profileBlock: formatProfileBlock(profile),
    statsBlock: formatStatsBlock(stats, profile.targetKcal),
    yesterdayBlock: formatYesterdayBlock(stats, user.tz),
    short: plan === "free"
  });
  // При недоступности text-провайдера ошибка ловится вызывающим,
  // запись в DailyAdvice не создаётся — совет уйдёт на следующем cron-тике.
  const res = await textClient.chatCompletion(
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    { attribution: { userId: user.id, purpose: "advice" } }
  );
  const text = res.text.trim();
  if (!text) return;

  await prisma.dailyAdvice.create({
    data: {
      userId: user.id,
      date: today,
      kind: "daily",
      adviceText: text,
      statsJson: JSON.parse(JSON.stringify(stats)) // Prisma Json
    }
  });
  const suffix = plan === "free" ? "\n\n💡 С Pro такие советы приходят каждый день." : "";
  await bot.api.sendMessage(Number(user.tgUserId), `🥗 Совет дня\n\n${text}${suffix}`);
  logger.info({ userId: user.id, plan }, "daily advice sent");
}

/** Запускается по расписанию: рассылает советы тем, у кого наступило adviceTime. */
export async function runDailyAdviceTick(now: Date = new Date(), budgetMs = DEFAULT_BUDGET_MS): Promise<void> {
  const profiles = await prisma.profile.findMany({
    where: { adviceEnabled: true },
    include: { user: true }
  });
  const deadline = Date.now() + budgetMs;
  let processed = 0;

  for (const batch of chunk(profiles, CONCURRENCY)) {
    if (Date.now() > deadline) {
      logger.warn({ processed, total: profiles.length }, "advice tick out of time, rest continues next tick");
      break;
    }
    await Promise.all(
      batch.map((profile) =>
        sendDailyAdvice(profile, now).catch((err) =>
          logger.error({ err: String(err), userId: profile.userId }, "daily advice failed")
        )
      )
    );
    processed += batch.length;
  }
}
