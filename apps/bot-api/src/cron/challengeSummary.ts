import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { bot } from "../bot/bot.js";
import { describeRule, ruleOf, settleDay } from "../services/challenges.js";
import { getDailyStats } from "../services/stats.js";
import { addDays, localDateStr } from "../utils/tz.js";
import { chunk } from "./schedule.js";

/**
 * Час вечерней сводки в местном времени участника.
 *
 * Вечером, а не утром: утром итог подводить нечего. Это тот самый крючок —
 * не «не забудь записать», а «ты прошёл четыре дня из десяти, не обнуляй».
 */
const SUMMARY_HOUR = 21;

const CONCURRENCY = 5;
const DEFAULT_BUDGET_MS = 20_000;

const ICON: Record<string, string> = { pass: "✅", fail: "❌", frozen: "🧊", skip: "➖" };

function summaryText(params: {
  title: string;
  ruleText: string;
  dayNo: number;
  days: number;
  status: string;
  factText: string;
  passed: number;
  finished: boolean;
  jokersLeft: number;
}): string {
  const { title, dayNo, days, status, factText, passed, finished } = params;
  if (finished) {
    const share = Math.round((passed / days) * 100);
    return [
      `🏁 <b>${title}</b> — финиш!`,
      "",
      `Засчитано дней: <b>${passed} из ${days}</b> (${share}%)`,
      "",
      passed === days
        ? "Полный проход. Это редкость — поздравляю 👏"
        : passed >= days * 0.7
          ? "Крепкий результат. Хотите повторить с планкой повыше?"
          : "Не всё вышло, но данные за период остались — посмотрите в дневнике, где именно сорвалось.",
      "",
      "Новый челлендж — /challenge"
    ].join("\n");
  }

  const left = days - dayNo;
  const lines = [
    `${ICON[status] ?? "•"} <b>${title}</b> · день ${dayNo} из ${days}`,
    "",
    `${params.ruleText} — сегодня ${factText}`
  ];
  if (status === "frozen") lines.push("", "День не задался, потратил заморозку — прогресс цел.");
  else if (status === "fail") lines.push("", params.jokersLeft > 0 ? "День не засчитан. Заморозка ещё есть." : "День не засчитан.");
  else if (status === "skip") lines.push("", "Записей за день нет — день не засчитан, но и прогресс не обнулён.");
  lines.push("", `Засчитано: ${passed}. Осталось дней: ${left}.`);
  return lines.join("\n");
}

/** Итог дня одному участнику. Бросает исключение — вызывающий логирует и идёт дальше. */
async function sendSummary(
  part: { challengeId: number; userId: number; jokersLeft: number },
  now: Date
): Promise<void> {
  const [user, challenge] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: part.userId } }),
    prisma.challenge.findUniqueOrThrow({ where: { id: part.challengeId } })
  ]);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: user.tz, hour: "2-digit", hour12: false }).format(now));
  const today = localDateStr(user.tz, now);

  // Последний ЗАВЕРШЁННЫЙ день: сегодняшний, если вечер уже наступил, иначе
  // вчерашний. Так итог доходит при любой частоте крона — на бесплатном тарифе
  // он может срабатывать всего раз в сутки, и привязка к «сейчас 21:00»
  // означала бы, что часть участников не получит сводку никогда.
  const date = hour >= SUMMARY_HOUR ? today : addDays(today, -1);

  // Заодно молча закрываем пропущенный предыдущий день, чтобы в календаре не
  // оставалось дыр. Сообщение шлём только за целевой день — по одному в сутки.
  const prev = addDays(date, -1);
  const stats = await getDailyStats(user.id, user.tz, 3, date);
  await settleDay({ challenge, userId: user.id, tz: user.tz, date: prev, stats }).catch(() => null);

  const outcome = await settleDay({ challenge, userId: user.id, tz: user.tz, date, stats });
  if (!outcome) return; // день уже подведён или челлендж ещё не начался

  const text = summaryText({
    title: challenge.title,
    ruleText: describeRule(ruleOf(challenge)),
    dayNo: outcome.dayNo,
    days: challenge.days,
    status: outcome.status,
    factText: outcome.factText,
    passed: outcome.progress.passed,
    finished: outcome.finished,
    jokersLeft: part.jokersLeft
  });
  await bot.api.sendMessage(Number(user.tgUserId), text, { parse_mode: "HTML" });
  logger.info({ userId: user.id, challengeId: challenge.id, status: outcome.status }, "challenge summary sent");
}

/** Запускается ежечасно: подводит итог тем, у кого уже наступил вечер. */
export async function runChallengeSummaryTick(now: Date = new Date(), budgetMs = DEFAULT_BUDGET_MS): Promise<void> {
  const parts = await prisma.challengeParticipant.findMany({
    where: { status: "active" },
    select: { challengeId: true, userId: true, jokersLeft: true }
  });
  const deadline = Date.now() + budgetMs;

  for (const batch of chunk(parts, CONCURRENCY)) {
    if (Date.now() > deadline) {
      logger.warn({ total: parts.length }, "challenge tick out of time, rest continues next tick");
      break;
    }
    await Promise.all(
      batch.map((p) =>
        sendSummary(p, now).catch((err) =>
          logger.error({ err: String(err), userId: p.userId }, "challenge summary failed")
        )
      )
    );
  }
}
