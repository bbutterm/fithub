import type { Profile, User } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { bot } from "../bot/bot.js";
import { textClient } from "../lib/ai.js";
import { buildDailyAdvicePrompt } from "../prompts/advice.js";
import { formatProfileBlock, formatStatsBlock, formatYesterdayBlock, getDailyStats } from "../services/stats.js";
import { getPlan } from "../services/subscription.js";
import { localDateStr, localTimeStr } from "../utils/tz.js";
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
const TICK_BUDGET_MS = 45_000;

/** Совет одному пользователю. Бросает исключение — вызывающий логирует и идёт дальше. */
async function sendDailyAdvice(profile: Profile & { user: User }, now: Date): Promise<void> {
  const { user } = profile;
  const nowLocal = localTimeStr(user.tz, now);
  if (nowLocal < profile.adviceTime) return;

  const today = localDateStr(user.tz, now);
  const exists = await prisma.dailyAdvice.findUnique({
    where: { userId_date_kind: { userId: user.id, date: today, kind: "daily" } }
  });
  if (exists) return;

  const plan = await getPlan(user.id);
  if (plan === "free" && !FREE_ADVICE_WEEKDAYS.has(localWeekday(user.tz, now))) return;

  const stats = await getDailyStats(user.id, user.tz, 7);
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
export async function runDailyAdviceTick(now: Date = new Date()): Promise<void> {
  const profiles = await prisma.profile.findMany({
    where: { adviceEnabled: true },
    include: { user: true }
  });
  const deadline = Date.now() + TICK_BUDGET_MS;
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
