import type * as LibAi from "../../lib/ai.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../db.js";
import { bot } from "../../bot/bot.js";
import { getDailyStats } from "../../services/stats.js";
import { extendPro } from "../../services/subscription.js";
import { runDailyAdviceTick } from "../../cron/dailyAdvice.js";
import { runMonthlyReportTick } from "../../cron/monthlyReport.js";
import { captureBotApi, makeMeal, makeProfile } from "./helpers.js";

// Совет и отчёт пишет модель — подменяем: проверяем расписание и адресатов.
vi.mock("../../lib/ai.js", async (orig) => {
  const actual = await orig<typeof LibAi>();
  return {
    ...actual,
    textClient: {
      ...actual.textClient,
      chatCompletion: vi.fn(async () => ({
        text: "Наблюдение по твоим данным.\n\nСегодня: добавь 150 г творога.",
        usage: { promptTokens: 1, completionTokens: 1 },
        costUsd: 0,
        latencyMs: 1,
        model: "stub"
      }))
    }
  };
});

const tg = captureBotApi(bot);

beforeEach(async () => {
  tg.clear();
  await bot.init();
});

async function userIn(tz: string, tgId: number, opts: { pro?: boolean; adviceTime?: string } = {}) {
  const user = await prisma.user.create({ data: { tgUserId: BigInt(tgId), firstName: tz, tz } });
  await makeProfile(user.id, { adviceTime: opts.adviceTime ?? "09:00" });
  if (opts.pro !== false) await extendPro(user.id, 30);
  return user;
}

describe("сутки считаются по часовому поясу человека", () => {
  it("поздний ужин в Москве — сегодняшний для Москвы и завтрашний для Владивостока", async () => {
    const moscow = await userIn("Europe/Moscow", 640001);
    const vlad = await userIn("Asia/Vladivostok", 640002);
    // 22:30 МСК = 05:30 следующего дня во Владивостоке
    const eatenAt = new Date("2026-03-10T19:30:00Z");
    await makeMeal(moscow.id, { eatenAt, kcal: 700 });
    await makeMeal(vlad.id, { eatenAt, kcal: 700 });

    const mskStats = await getDailyStats(moscow.id, "Europe/Moscow", 3, "2026-03-10");
    const vladStats = await getDailyStats(vlad.id, "Asia/Vladivostok", 3, "2026-03-10");

    expect(mskStats.find((s) => s.date === "2026-03-10")?.kcal).toBe(700);
    expect(vladStats.find((s) => s.date === "2026-03-10")?.kcal).toBe(0);
    expect((await getDailyStats(vlad.id, "Asia/Vladivostok", 3, "2026-03-11")).find((s) => s.date === "2026-03-11")?.kcal).toBe(700);
  });

  it("поздний приём отмечается как поздний по местному времени", async () => {
    const moscow = await userIn("Europe/Moscow", 640003);
    await makeMeal(moscow.id, { eatenAt: new Date("2026-03-10T19:30:00Z") }); // 22:30 МСК
    const stats = await getDailyStats(moscow.id, "Europe/Moscow", 1, "2026-03-10");
    expect(stats[0]).toMatchObject({ lateMeals: 1, hadBreakfast: false });
  });
});

describe("ежедневный совет", () => {
  it("за один тик каждому уходит не больше одного совета, и дважды за дату — никогда", async () => {
    const vlad = await userIn("Asia/Vladivostok", 640010);
    const msk = await userIn("Europe/Moscow", 640011);
    const lisbon = await userIn("Europe/Lisbon", 640012);
    for (const u of [vlad, msk, lisbon]) await makeMeal(u.id, { eatenAt: new Date("2026-03-09T12:00:00Z") });

    // 20:00 UTC: 09:00 по местному времени уже прошло у всех троих
    await runDailyAdviceTick(new Date("2026-03-10T20:00:00Z"));
    const first = await prisma.dailyAdvice.findMany({ where: { kind: "daily" } });
    expect(first).toHaveLength(3);
    expect(new Set(first.map((r) => r.userId)).size).toBe(3);

    // Тик повторяется — дубль за ту же дату создать нельзя
    await runDailyAdviceTick(new Date("2026-03-10T21:00:00Z"));
    const all = await prisma.dailyAdvice.findMany({ where: { kind: "daily" } });
    const pairs = all.map((r) => `${r.userId}:${r.date}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("пропущенный вчерашний совет досылается один раз и на этом останавливается", async () => {
    const user = await userIn("Europe/Moscow", 640016);
    await makeMeal(user.id, { eatenAt: new Date("2026-03-08T12:00:00Z") });

    // Крон на бесплатном тарифе будит раз в сутки, поэтому вчерашний совет
    // досылается следующим тиком — иначе он не ушёл бы никогда.
    // 18:00 и 19:00 UTC — это 21:00 и 22:00 МСК, оба тика внутри одних местных суток
    await runDailyAdviceTick(new Date("2026-03-10T18:00:00Z"));
    await runDailyAdviceTick(new Date("2026-03-10T19:00:00Z"));
    const dates = (await prisma.dailyAdvice.findMany({ where: { userId: user.id }, orderBy: { date: "asc" } })).map((r) => r.date);
    expect(dates).toEqual(["2026-03-09", "2026-03-10"]);

    await runDailyAdviceTick(new Date("2026-03-10T19:30:00Z"));
    expect(await prisma.dailyAdvice.count({ where: { userId: user.id } })).toBe(2);
  });

  it("без записей советовать нечего", async () => {
    await userIn("Europe/Moscow", 640013);
    await runDailyAdviceTick(new Date("2026-03-10T20:00:00Z"));
    expect(await prisma.dailyAdvice.count()).toBe(0);
  });

  it("выключенные советы не приходят", async () => {
    const user = await userIn("Europe/Moscow", 640014);
    await prisma.profile.update({ where: { userId: user.id }, data: { adviceEnabled: false } });
    await makeMeal(user.id, { eatenAt: new Date("2026-03-09T12:00:00Z") });

    await runDailyAdviceTick(new Date("2026-03-10T20:00:00Z"));
    expect(await prisma.dailyAdvice.count()).toBe(0);
  });

  it("в тексте нет markdown-звёздочек", async () => {
    const user = await userIn("Europe/Moscow", 640015);
    await makeMeal(user.id, { eatenAt: new Date("2026-03-09T12:00:00Z") });
    await runDailyAdviceTick(new Date("2026-03-10T20:00:00Z"));
    expect(tg.texts()).not.toContain("**");
  });
});

describe("месячный отчёт", () => {
  it("уходит в начале месяца и только один раз", async () => {
    const user = await userIn("Europe/Moscow", 640020);
    await makeMeal(user.id, { eatenAt: new Date("2026-02-15T12:00:00Z") });

    await runMonthlyReportTick(new Date("2026-03-01T09:00:00Z"));
    expect(await prisma.dailyAdvice.count({ where: { kind: "monthly" } })).toBe(1);

    await runMonthlyReportTick(new Date("2026-03-02T09:00:00Z"));
    expect(await prisma.dailyAdvice.count({ where: { kind: "monthly" } })).toBe(1);
  });

  it("в середине месяца не уходит", async () => {
    const user = await userIn("Europe/Moscow", 640021);
    await makeMeal(user.id, { eatenAt: new Date("2026-02-15T12:00:00Z") });

    await runMonthlyReportTick(new Date("2026-03-15T09:00:00Z"));
    expect(await prisma.dailyAdvice.count({ where: { kind: "monthly" } })).toBe(0);
  });

  it("бесплатному тарифу месячный отчёт не положен", async () => {
    const user = await prisma.user.create({ data: { tgUserId: BigInt(640022), tz: "Europe/Moscow" } });
    await makeProfile(user.id);
    await makeMeal(user.id, { eatenAt: new Date("2026-02-15T12:00:00Z") });

    await runMonthlyReportTick(new Date("2026-03-01T09:00:00Z"));
    expect(await prisma.dailyAdvice.count({ where: { kind: "monthly" } })).toBe(0);
  });
});
