import type * as FoodAi from "../../ai/food.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../db.js";
import { bot } from "../../bot/bot.js";
import { runReminderTick } from "../../cron/reminders.js";
import { captureBotApi, callbackUpdate, makeMeal, makeProfile, mskAt, mskDate, textUpdate } from "./helpers.js";

// Распознавание и проверка режима питания подменены: тесты про поведение бота,
// а не про качество модели. Еда одна и та же во всех сценариях.
vi.mock("../../ai/food.js", async (orig) => ({
  ...(await orig<typeof FoodAi>()),
  recognizeFoodText: vi.fn(async () => ({
    items: [{ dish: "картофель жареный", grams: 200, kcal: 380, protein: 6, fat: 18, carbs: 48, confidence: 0.8 }],
    overall_confidence: 0.8,
    model: "stub"
  })),
  interpretUserText: vi.fn(async () => ({ action: "other" as const, items: [] }))
}));
vi.mock("../../ai/dietCheck.js", () => ({
  checkMealAgainstDiet: vi.fn(async () => ({ verdict: "avoid", note: "Жареный картофель по столу №5 не подходит." }))
}));

const CHAT = 610000;
const TG = { id: 610000, first_name: "Тест" };
const tg = captureBotApi(bot);

let userId: number;
const today = mskDate(new Date());
const evening = mskAt(today, "21:00");

beforeEach(async () => {
  tg.clear();
  await bot.init();
  const user = await prisma.user.create({ data: { tgUserId: BigInt(TG.id), firstName: "Тест" } });
  userId = user.id;
  await makeProfile(userId, { medicalDiets: ["table5"] });
});

describe("режим «можно?»", () => {
  it("вопрос проверяет еду, но не пишет её в дневник", async () => {
    await bot.handleUpdate(textUpdate(CHAT, TG, "можно мне жареную картошку?"));

    const card = tg.last()?.text ?? "";
    expect(card).toContain("Проверка");
    expect(card).toContain("не записано");
    expect(card).toContain("стол");
    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
    expect(await prisma.quickCheck.count({ where: { userId } })).toBe(1);
  });

  it("кнопка «записать» создаёт приём без повторного вызова модели", async () => {
    const { recognizeFoodText } = await import("../../ai/food.js");
    await bot.handleUpdate(textUpdate(CHAT, TG, "можно мне жареную картошку?"));
    const callback = tg.sent.flatMap((s) => s.data).find((d) => d.startsWith("chk:log:"))!;
    const callsBefore = vi.mocked(recognizeFoodText).mock.calls.length;

    await bot.handleUpdate(callbackUpdate(CHAT, TG, callback));

    expect(vi.mocked(recognizeFoodText).mock.calls.length).toBe(callsBefore);
    const meal = await prisma.meal.findFirstOrThrow({ where: { userId } });
    expect(meal.dietVerdict).toBe("avoid");
    expect(await prisma.quickCheck.count({ where: { userId } })).toBe(0);
  });

  it("повторное нажатие на устаревшую проверку не создаёт вторую запись", async () => {
    await bot.handleUpdate(textUpdate(CHAT, TG, "можно мне жареную картошку?"));
    const callback = tg.sent.flatMap((s) => s.data).find((d) => d.startsWith("chk:log:"))!;
    await bot.handleUpdate(callbackUpdate(CHAT, TG, callback));
    tg.clear();

    await bot.handleUpdate(callbackUpdate(CHAT, TG, callback));
    expect(tg.texts()).toContain("устарела");
    expect(await prisma.meal.count({ where: { userId } })).toBe(1);
  });

  it("вопрос про уже записанную еду остаётся уточнением, а не проверкой", async () => {
    await makeMeal(userId, { eatenAt: new Date() });
    tg.clear();
    await bot.handleUpdate(textUpdate(CHAT, TG, "там точно 200 грамм?"));

    expect(tg.texts()).not.toContain("Проверка");
    expect(await prisma.quickCheck.count({ where: { userId } })).toBe(0);
  });
});

describe("вечернее напоминание", () => {
  beforeEach(async () => {
    // Две записи в прошлые дни: человек активен, и есть из чего считать среднее
    await makeMeal(userId, { kcal: 1800, protein: 100, eatenAt: new Date(evening.getTime() - 2 * 86_400_000) });
    await makeMeal(userId, { kcal: 2200, protein: 120, eatenAt: new Date(evening.getTime() - 3 * 86_400_000) });
    tg.clear();
  });

  it("при пустом дне вечером приходит напоминание с тремя кнопками", async () => {
    await runReminderTick(evening);
    const last = tg.last();
    expect(last?.text).toContain("дневнике пусто");
    expect(last?.buttons).toHaveLength(3);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ lastReminderDate: today });
  });

  it("второй раз за день и днём — не приходит", async () => {
    await runReminderTick(evening);
    tg.clear();

    await runReminderTick(evening);
    expect(tg.sent).toHaveLength(0);

    await prisma.user.update({ where: { id: userId }, data: { lastReminderDate: null } });
    await runReminderTick(mskAt(today, "12:00"));
    expect(tg.sent).toHaveLength(0);
  });

  it("если за день есть запись, напоминание не приходит", async () => {
    await makeMeal(userId, { eatenAt: evening });
    await runReminderTick(evening);
    expect(tg.sent).toHaveLength(0);
  });

  it("давно неактивному не пишем", async () => {
    await prisma.meal.deleteMany({ where: { userId } });
    await makeMeal(userId, { eatenAt: new Date(evening.getTime() - 40 * 86_400_000) });
    await prisma.user.update({ where: { id: userId }, data: { createdAt: new Date(evening.getTime() - 60 * 86_400_000) } });
    tg.clear();

    await runReminderTick(evening);
    expect(tg.sent).toHaveLength(0);
  });

  it("«ел как обычно» пишет средний день, повтор — отказ", async () => {
    await bot.handleUpdate(callbackUpdate(CHAT, TG, "rem:usual"));
    const meal = await prisma.meal.findFirstOrThrow({ where: { userId, source: "manual" }, include: { items: true } });
    expect(meal.items[0]!.dish).toContain("Обычный день");
    expect(Math.round(meal.totalKcal)).toBe(2000);
    expect(Math.round(meal.totalProtein)).toBe(110);

    tg.clear();
    await bot.handleUpdate(callbackUpdate(CHAT, TG, "rem:usual"));
    expect(tg.texts()).toContain("уже есть записи");
  });

  it("«не напоминать» выключает рассылку", async () => {
    await bot.handleUpdate(callbackUpdate(CHAT, TG, "rem:off"));
    expect(await prisma.profile.findUniqueOrThrow({ where: { userId } })).toMatchObject({ reminderEnabled: false });

    tg.clear();
    await runReminderTick(evening);
    expect(tg.sent).toHaveLength(0);
  });
});
