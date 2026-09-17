import { randomBytes } from "node:crypto";
import type { Challenge, ChallengeParticipant } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { textClient } from "../lib/ai.js";
import { JSON_RETRY_PROMPT } from "../prompts/vision.js";
import { z } from "zod";
import {
  describeDayFacts,
  describeRule,
  evaluateDay,
  factsFromStat,
  type ChallengeRule,
  type DayFacts,
  type DayStatus
} from "../challenges.js";
import { addDays, localDateStr } from "../utils/tz.js";
import { getDailyStats, type DayStat } from "./stats.js";

export function ruleOf(challenge: Challenge): ChallengeRule {
  return challenge.rule as unknown as ChallengeRule;
}

// Без похожих символов: код диктуют голосом и набирают руками, а 0/O и 1/I/L
// в такой ситуации путают постоянно.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newJoinCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/**
 * Один активный челлендж на человека.
 *
 * Три одновременных челленджа — это ноль выполненных: внимание не делится.
 * Заодно это естественная граница free/pro, когда вернётся оплата.
 */
export async function activeChallengeOf(userId: number) {
  return prisma.challengeParticipant.findFirst({
    where: { userId, status: "active" },
    include: { challenge: true }
  });
}

export async function createChallenge(params: {
  ownerId: number;
  title: string;
  rule: ChallengeRule;
  days: number;
  tz: string;
}): Promise<Challenge> {
  // Старт со следующего дня: сегодняшний уже наполовину прошёл, и засчитывать
  // его — первый источник несправедливого провала.
  const startDate = addDays(localDateStr(params.tz), 1);
  // Код уникален: совпадение маловероятно, но упасть на создании челленджа
  // из-за него нельзя — пробуем несколько раз
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.challenge.create({
        data: {
          ownerId: params.ownerId,
          title: params.title,
          rule: params.rule as unknown as object,
          days: params.days,
          startDate,
          joinCode: newJoinCode(),
          participants: { create: { userId: params.ownerId } }
        }
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      logger.warn({ attempt }, "join code collision, retrying");
    }
  }
}

export async function joinChallenge(challengeId: number, userId: number): Promise<ChallengeParticipant | null> {
  const existing = await activeChallengeOf(userId);
  if (existing) return null; // уже участвует в другом
  return prisma.challengeParticipant.upsert({
    where: { challengeId_userId: { challengeId, userId } },
    create: { challengeId, userId },
    update: { status: "active" }
  });
}

export async function quitChallenge(challengeId: number, userId: number): Promise<void> {
  await prisma.challengeParticipant.updateMany({
    where: { challengeId, userId },
    data: { status: "quit" }
  });
}

export async function challengeByCode(code: string) {
  return prisma.challenge.findUnique({ where: { joinCode: code.toUpperCase() } });
}

/** Сколько дней челленджа прошло к локальной дате (1 — первый день). */
export function dayNumber(challenge: Challenge, localDate: string): number {
  const start = Date.parse(`${challenge.startDate}T00:00:00Z`);
  const now = Date.parse(`${localDate}T00:00:00Z`);
  return Math.floor((now - start) / 86_400_000) + 1;
}

export interface Progress {
  passed: number;
  failed: number;
  skipped: number;
  frozen: number;
  total: number;
}

export async function progressOf(challengeId: number, userId: number, days: number): Promise<Progress> {
  const rows = await prisma.challengeDay.findMany({ where: { challengeId, userId } });
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skip"),
    frozen: count("frozen"),
    total: days
  };
}

const avoidSchema = z.object({ contains: z.boolean() });

/**
 * Проверка запрета по составу дня.
 *
 * «Без сладкого» нельзя посчитать числами, но можно спросить текстовую модель
 * один раз в конце дня — это копейки и открывает целый класс челленджей,
 * которые иначе невозможны. Не ответила — день считается пропущенным,
 * а не проваленным.
 */
async function judgeAvoid(judge: string, dishes: string[], userId: number): Promise<boolean | undefined> {
  if (dishes.length === 0) return undefined;
  try {
    const res = await textClient.chatCompletionJson(
      [
        {
          role: "system",
          content:
            "Тебе дают список блюд за день и категорию запрета. Ответь, есть ли среди блюд что-то из этой категории. " +
            'Отвечай ТОЛЬКО валидным JSON без markdown: {"contains":true|false}'
        },
        { role: "user", content: `Категория запрета: ${judge}\n\nБлюда за день:\n${dishes.map((d) => `- ${d}`).join("\n")}` }
      ],
      avoidSchema,
      JSON_RETRY_PROMPT,
      { attribution: { userId, purpose: "challenge_judge" } }
    );
    return !res.value.contains;
  } catch (err) {
    logger.warn({ err: String(err), userId }, "challenge avoid judge failed");
    return undefined;
  }
}

/** Час самого раннего приёма пищи за локальные сутки. */
async function firstMealHour(userId: number, tz: string, date: string): Promise<number | null> {
  const { zonedDayRangeUtc } = await import("../utils/tz.js");
  const { start, end } = zonedDayRangeUtc(date, tz);
  const meal = await prisma.meal.findFirst({
    where: { userId, eatenAt: { gte: start, lt: end } },
    orderBy: { eatenAt: "asc" },
    select: { eatenAt: true }
  });
  if (!meal) return null;
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(meal.eatenAt));
}

export interface DayOutcome {
  status: DayStatus | "frozen";
  facts: DayFacts;
  factText: string;
  dayNo: number;
  progress: Progress;
  finished: boolean;
}

/**
 * Подвести итог дня и записать его.
 *
 * Повторный вызов за тот же день ничего не меняет: результат уже сохранён,
 * и это защита от второго запуска крона.
 */
export async function settleDay(params: {
  challenge: Challenge;
  userId: number;
  tz: string;
  date: string;
  stats: DayStat[];
}): Promise<DayOutcome | null> {
  const { challenge, userId, tz, date } = params;
  const dayNo = dayNumber(challenge, date);
  if (dayNo < 1 || dayNo > challenge.days) return null;

  const existing = await prisma.challengeDay.findUnique({
    where: { challengeId_userId_date: { challengeId: challenge.id, userId, date } }
  });
  if (existing) return null;

  const stat = params.stats.find((s) => s.date === date);
  if (!stat) return null;
  const facts = factsFromStat(stat, await firstMealHour(userId, tz, date));
  const rule = ruleOf(challenge);

  let status: DayStatus | "frozen" =
    rule.type === "avoid"
      ? evaluateDay(rule, facts, await judgeAvoid(rule.judge, stat.dishes, userId))
      : evaluateDay(rule, facts);

  // Провал можно закрыть заморозкой — один раз за челлендж. Без этого первый же
  // сорванный день выгоняет человека не из челленджа, а из бота.
  if (status === "fail") {
    const part = await prisma.challengeParticipant.findUnique({
      where: { challengeId_userId: { challengeId: challenge.id, userId } }
    });
    if (part && part.jokersLeft > 0) {
      await prisma.challengeParticipant.update({
        where: { challengeId_userId: { challengeId: challenge.id, userId } },
        data: { jokersLeft: { decrement: 1 } }
      });
      status = "frozen";
    }
  }

  const factText = describeDayFacts(rule, facts);
  await prisma.challengeDay.create({
    data: { challengeId: challenge.id, userId, date, status, fact: factText }
  });

  const progress = await progressOf(challenge.id, userId, challenge.days);
  const finished = dayNo >= challenge.days;
  if (finished) {
    await prisma.challengeParticipant.updateMany({
      where: { challengeId: challenge.id, userId },
      data: { status: "done" }
    });
  }
  return { status, facts, factText, dayNo, progress, finished };
}

/** История за две недели — для проверки выполнимости перед стартом. */
export async function historyFacts(userId: number, tz: string): Promise<DayFacts[]> {
  const stats = await getDailyStats(userId, tz, 14);
  return Promise.all(stats.map(async (s) => factsFromStat(s, await firstMealHour(userId, tz, s.date))));
}

export { describeRule };
