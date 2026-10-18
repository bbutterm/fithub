import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";
import { prisma } from "../../db.js";
import { bot } from "../../bot/bot.js";
import { NoFoodError } from "../../ai/food.js";
import { AiUnavailableError } from "../../lib/ai.js";
import { captureBotApi, makeProfile, textUpdate } from "./helpers.js";

/**
 * Что должно происходить, когда модель не отвечает: человек видит понятный
 * текст, потраченная попытка возвращается, блокировка снимается — следующий
 * запрос проходит. Без этого один сбой провайдера съедал дневной лимит.
 */
vi.mock("../../services/tgfiles.js", () => ({
  telegramFileToDataUrl: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
  downloadTelegramFile: vi.fn(async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" }))
}));
vi.mock("../../ai/food.js", async (orig) => {
  const actual = await orig<typeof import("../../ai/food.js")>();
  return { ...actual, recognizeFoodPhoto: vi.fn(), interpretUserText: vi.fn(async () => ({ action: "other" as const, items: [] })) };
});
vi.mock("../../ai/dietCheck.js", () => ({ checkMealAgainstDiet: vi.fn(async () => null) }));

const CHAT = 660000;
const TG = { id: 660000, first_name: "Сбой" };
const tg = captureBotApi(bot);
let userId: number;

const photoUpdate = (): Update =>
  ({
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 8001,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "private" },
      from: { is_bot: false, ...TG },
      photo: [{ file_id: "large", file_unique_id: "l", width: 1280, height: 960 }]
    }
  }) as Update;

const good = {
  items: [{ dish: "суп", grams: 300, kcal: 200, protein: 10, fat: 5, carbs: 20, confidence: 0.9 }],
  overall_confidence: 0.9,
  model: "stub"
};

beforeEach(async () => {
  tg.clear();
  vi.clearAllMocks();
  await bot.init();
  const user = await prisma.user.create({ data: { tgUserId: BigInt(TG.id), firstName: "Сбой" } });
  userId = user.id;
  await makeProfile(userId);
});

describe("провайдер недоступен", () => {
  it("человек видит понятное сообщение, а не молчание", async () => {
    const { recognizeFoodPhoto } = await import("../../ai/food.js");
    vi.mocked(recognizeFoodPhoto).mockRejectedValueOnce(new AiUnavailableError("HTTP 503"));

    await bot.handleUpdate(photoUpdate());

    expect(tg.texts()).toContain("Не получилось распознать");
    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
  });

  it("потраченная попытка возвращается в дневной лимит", async () => {
    const { recognizeFoodPhoto } = await import("../../ai/food.js");
    vi.mocked(recognizeFoodPhoto).mockRejectedValueOnce(new AiUnavailableError("HTTP 429"));

    await bot.handleUpdate(photoUpdate());

    const counter = await prisma.usageCounter.findFirst({ where: { userId } });
    expect(counter?.photoCount ?? 0).toBe(0);
  });

  it("после сбоя следующее фото проходит: блокировка снята", async () => {
    const { recognizeFoodPhoto } = await import("../../ai/food.js");
    vi.mocked(recognizeFoodPhoto).mockRejectedValueOnce(new AiUnavailableError("timeout"));
    await bot.handleUpdate(photoUpdate());
    tg.clear();

    vi.mocked(recognizeFoodPhoto).mockResolvedValueOnce(good);
    await bot.handleUpdate(photoUpdate());

    expect(await prisma.meal.count({ where: { userId } })).toBe(1);
    expect(tg.texts()).toContain("Записал приём пищи");
  });
});

describe("на фото нет еды", () => {
  it("бот объясняет, что делать, и не тратит попытку", async () => {
    const { recognizeFoodPhoto } = await import("../../ai/food.js");
    vi.mocked(recognizeFoodPhoto).mockRejectedValueOnce(new NoFoodError());

    await bot.handleUpdate(photoUpdate());

    expect(tg.texts()).toContain("не вижу еды");
    expect((await prisma.usageCounter.findFirst({ where: { userId } }))?.photoCount ?? 0).toBe(0);
  });
});

describe("сбой при отрисовке карточки", () => {
  it("запись сохраняется, человек получает итоги, попытка не возвращается", async () => {
    const { recognizeFoodPhoto } = await import("../../ai/food.js");
    const { checkMealAgainstDiet } = await import("../../ai/dietCheck.js");
    vi.mocked(recognizeFoodPhoto).mockResolvedValueOnce(good);
    vi.mocked(checkMealAgainstDiet).mockRejectedValueOnce(new Error("diet provider down"));

    await bot.handleUpdate(photoUpdate());

    expect(await prisma.meal.count({ where: { userId } })).toBe(1);
    expect(tg.texts()).toContain("Записал приём пищи: 200 ккал");
    expect(tg.texts()).not.toContain("Не получилось распознать");
    // Распознавание состоялось и стоило денег — возвращать попытку не за что
    expect((await prisma.usageCounter.findFirstOrThrow({ where: { userId } })).photoCount).toBe(1);
  });

  it("обычная карточка приходит, когда всё в порядке", async () => {
    const { recognizeFoodPhoto } = await import("../../ai/food.js");
    vi.mocked(recognizeFoodPhoto).mockResolvedValueOnce(good);

    await bot.handleUpdate(photoUpdate());

    expect(tg.texts()).toContain("Записал приём пищи");
    expect(tg.sent.at(-1)?.buttons).toContain("💾 В мои блюда");
  });
});

describe("текст вместо фото при неработающем провайдере", () => {
  it("сообщение об ошибке приходит и на текстовый путь", async () => {
    const food = await import("../../ai/food.js");
    const spy = vi.spyOn(food, "recognizeFoodText").mockRejectedValueOnce(new AiUnavailableError("HTTP 500"));

    await bot.handleUpdate(textUpdate(CHAT, TG, "тарелка борща и два куска хлеба"));

    expect(tg.texts()).toContain("Не получилось распознать");
    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
    spy.mockRestore();
  });
});
