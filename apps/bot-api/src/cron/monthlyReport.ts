import type { Profile, User } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { bot } from "../bot/bot.js";
import { textClient } from "../lib/ai.js";
import { buildMonthlyReportPrompt } from "../prompts/advice.js";
import { formatProfileBlock, getDailyStats, type DayStat } from "../services/stats.js";
import { getPlan } from "../services/subscription.js";
import { localDateStr } from "../utils/tz.js";
import { chunk, shouldSendMonthly } from "./schedule.js";

function prevMonthRange(todayLocal: string): { monthKey: string; start: string; end: string; days: number; label: string } {
  const [y, m] = todayLocal.split("-").map(Number) as [number, number, ...number[]];
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const mm = String(prevM).padStart(2, "0");
  const daysInMonth = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const monthNames = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  return {
    monthKey: `${prevY}-${mm}-01`,
    start: `${prevY}-${mm}-01`,
    end: `${prevY}-${mm}-${String(daysInMonth).padStart(2, "0")}`,
    days: daysInMonth,
    label: `${monthNames[prevM - 1]} ${prevY}`
  };
}

function buildMonthStatsBlock(stats: DayStat[], targetKcal: number | null): string {
  const logged = stats.filter((s) => s.mealsCount > 0);
  if (logged.length === 0) return "Записей за месяц не было.";
  const avg = (sel: (s: DayStat) => number) => Math.round(logged.reduce((sum, s) => sum + sel(s), 0) / logged.length);

  // Недели: разбиваем месяц по 7 дней и сравниваем среднюю калорийность с целью
  const weeks: Array<{ label: string; avgKcal: number; daysLogged: number }> = [];
  for (let i = 0; i < stats.length; i += 7) {
    const chunk = stats.slice(i, i + 7);
    const wl = chunk.filter((s) => s.mealsCount > 0);
    weeks.push({
      label: `${chunk[0]?.date ?? ""} — ${chunk[chunk.length - 1]?.date ?? ""}`,
      avgKcal: wl.length ? Math.round(wl.reduce((s, x) => s + x.kcal, 0) / wl.length) : 0,
      daysLogged: wl.length
    });
  }

  const dishCount = new Map<string, number>();
  for (const s of stats) for (const d of s.dishes) dishCount.set(d.toLowerCase(), (dishCount.get(d.toLowerCase()) ?? 0) + 1);
  const topDishes = [...dishCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines = [
    `Дней с записями: ${logged.length} из ${stats.length}`,
    `Средние за день: ${avg((s) => s.kcal)} ккал, Б ${avg((s) => s.protein)} / Ж ${avg((s) => s.fat)} / У ${avg((s) => s.carbs)}`,
    targetKcal ? `Цель: ${targetKcal} ккал/день` : "Цель по калориям не задана",
    "Недели (средние ккал/день): " + weeks.map((w) => `${w.label}: ${w.avgKcal || "нет данных"}`).join("; "),
    topDishes.length ? `Топ-5 блюд: ${topDishes.map(([d, c]) => `${d} (${c}×)`).join(", ")}` : "",
    "Динамика веса: пользователь не вводил повторные замеры веса — не выдумывай цифры."
  ];
  return lines.filter(Boolean).join("\n");
}

// Один вызов ИИ занимает секунды, а serverless-функцию убивают на 60-й — поэтому
// пользователи обрабатываются пачками параллельно и с запасом по времени.
// Недошедшие получат отчёт на следующем тике: дубли исключает уникальный ключ DailyAdvice.
const CONCURRENCY = 5;
const TICK_BUDGET_MS = 45_000;

/** Отчёт одному пользователю. Бросает исключение — вызывающий логирует и идёт дальше. */
async function sendMonthlyReport(profile: Profile & { user: User }, now: Date): Promise<void> {
  const { user } = profile;
  const today = localDateStr(user.tz, now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: user.tz, hour: "2-digit", hour12: false }).format(now));
  if (!shouldSendMonthly(today, hour)) return;
  if ((await getPlan(user.id)) !== "pro") return;

  const range = prevMonthRange(today);
  const exists = await prisma.dailyAdvice.findUnique({
    where: { userId_date_kind: { userId: user.id, date: range.monthKey, kind: "monthly" } }
  });
  if (exists) return;

  const stats = await getDailyStats(user.id, user.tz, range.days, range.end);
  if (stats.every((s) => s.mealsCount === 0)) return;

  const prompt = buildMonthlyReportPrompt({
    tone: profile.adviceTone,
    profileBlock: formatProfileBlock(profile),
    statsBlock: buildMonthStatsBlock(stats, profile.targetKcal),
    monthLabel: range.label
  });
  // Ошибка провайдера ловится вызывающим — отчёт уйдёт на следующем тике.
  const res = await textClient.chatCompletion(
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    { attribution: { userId: user.id, purpose: "monthly" } }
  );
  const text = res.text.trim();
  if (!text) return;

  await prisma.dailyAdvice.create({
    data: { userId: user.id, date: range.monthKey, kind: "monthly", adviceText: text, statsJson: JSON.parse(JSON.stringify(stats)) }
  });
  await bot.api.sendMessage(Number(user.tgUserId), `📈 Отчёт за ${range.label}\n\n${text}`);
  logger.info({ userId: user.id, month: range.monthKey }, "monthly report sent");
}

/** Запускается по расписанию: в первые дни месяца шлёт Pro-пользователям отчёт за прошлый месяц. */
export async function runMonthlyReportTick(now: Date = new Date()): Promise<void> {
  const profiles = await prisma.profile.findMany({ include: { user: true } });
  const deadline = Date.now() + TICK_BUDGET_MS;
  let processed = 0;

  for (const batch of chunk(profiles, CONCURRENCY)) {
    if (Date.now() > deadline) {
      logger.warn({ processed, total: profiles.length }, "monthly tick out of time, rest continues next tick");
      break;
    }
    await Promise.all(
      batch.map((profile) =>
        sendMonthlyReport(profile, now).catch((err) =>
          logger.error({ err: String(err), userId: profile.userId }, "monthly report failed")
        )
      )
    );
    processed += batch.length;
  }
}

export { prevMonthRange, buildMonthStatsBlock };
