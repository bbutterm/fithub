import type * as FoodAi from "../../ai/food.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";
import { prisma } from "../../db.js";
import { bot } from "../../bot/bot.js";
import { localDateStr } from "../../utils/tz.js";
import { captureBotApi, callbackUpdate, makeMeal, makeProfile, textUpdate } from "./helpers.js";

const recognized = {
  items: [
    { dish: "куриная грудка", grams: 180, kcal: 300, protein: 40, fat: 6, carbs: 2, confidence: 0.9 },
    { dish: "рис отварной", grams: 170, kcal: 220, protein: 8, fat: 5, carbs: 56, confidence: 0.9 }
  ],
  overall_confidence: 0.9,
  model: "stub"
};

vi.mock("../../services/tgfiles.js", () => ({
  telegramFileToDataUrl: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
  downloadTelegramFile: vi.fn(async () => ({ buffer: Buffer.from("audio"), contentType: "audio/ogg" }))
}));
vi.mock("../../ai/food.js", async (orig) => ({
  ...(await orig<typeof FoodAi>()),
  recognizeFoodPhoto: vi.fn(async () => recognized),
  recognizeFoodText: vi.fn(async () => recognized),
  transcribeVoice: vi.fn(async () => "тарелка борща"),
  correctMealItems: vi.fn(async () => ({
    items: [{ dish: "индейка", grams: 200, kcal: 260, protein: 44, fat: 7, carbs: 0, confidence: 0.9 }],
    model: "stub"
  })),
  interpretUserText: vi.fn(async () => ({ action: "other" as const, items: [] }))
}));
vi.mock("../../ai/dietCheck.js", () => ({ checkMealAgainstDiet: vi.fn(async () => null) }));

const CHAT = 620000;
const TG = { id: 620000, first_name: "Тест" };
const tg = captureBotApi(bot);

let userId: number;

function photoUpdate(): Update {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 7001,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "private" },
      from: { is_bot: false, ...TG },
      photo: [
        { file_id: "small", file_unique_id: "s", width: 320, height: 240, file_size: 1000 },
        { file_id: "large", file_unique_id: "l", width: 1280, height: 960, file_size: 9000 }
      ]
    }
  } as Update;
}

function voiceUpdate(duration = 5): Update {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 7101,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "private" },
      from: { is_bot: false, ...TG },
      voice: { file_id: "voice1", file_unique_id: "v", duration, mime_type: "audio/ogg" }
    }
  } as Update;
}

beforeEach(async () => {
  tg.clear();
  vi.clearAllMocks();
  await bot.init();
});

async function existingUser() {
  const user = await prisma.user.create({ data: { tgUserId: BigInt(TG.id), firstName: "Тест" } });
  await makeProfile(user.id);
  userId = user.id;
  return user;
}

describe("знакомство", () => {
  it("/start заводит пользователя и рассказывает, что умеет бот", async () => {
    await bot.handleUpdate(textUpdate(CHAT, TG, "/start"));
    expect(tg.texts()).toContain("фото еды");
    expect(await prisma.user.count({ where: { tgUserId: BigInt(TG.id) } })).toBe(1);
  });

  it("/day без записей говорит об этом прямо", async () => {
    await existingUser();
    tg.clear();
    await bot.handleUpdate(textUpdate(CHAT, TG, "/day"));
    expect(tg.texts()).toContain("Записей пока нет");
  });
});

describe("фото еды", () => {
  it("распознаётся, пишется в дневник и показывается карточкой", async () => {
    await existingUser();
    tg.clear();

    await bot.handleUpdate(photoUpdate());

    const meal = await prisma.meal.findFirstOrThrow({ where: { userId }, include: { items: true } });
    expect(meal.items).toHaveLength(2);
    expect(meal.totalKcal).toBe(520);
    const card = tg.last()?.text ?? "";
    expect(card).toContain("Записал приём пищи");
    expect(tg.sent.at(-1)?.buttons).toContain("💾 В мои блюда");
  });

  it("при исчерпанном лимите фото не распознаётся", async () => {
    const user = await existingUser();
    const { recognizeFoodPhoto } = await import("../../ai/food.js");
    await prisma.user.update({ where: { id: user.id }, data: { dailyLimitOverride: 0 } });
    tg.clear();

    await bot.handleUpdate(photoUpdate());

    expect(vi.mocked(recognizeFoodPhoto)).not.toHaveBeenCalled();
    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
    expect(tg.texts()).toContain("лимит");
  });

  it.each([
    ["фото", () => photoUpdate()],
    ["текст", () => textUpdate(CHAT, TG, "овсянка на завтрак")],
    ["голос", () => voiceUpdate()]
  ])("исчерпанный лимит объясняется одинаково для %s", async (_label, makeUpdate) => {
    const user = await existingUser();
    await prisma.user.update({ where: { id: user.id }, data: { dailyLimitOverride: 7 } });
    await prisma.usageCounter.create({ data: { userId: user.id, date: localDateStr(user.tz), photoCount: 7 } });
    tg.clear();

    await bot.handleUpdate(makeUpdate());

    const text = tg.texts();
    expect(text).toContain("7");
    expect(text).toContain("завтра");
    // Пока покупки выключены, текст не должен ничего продавать
    expect(text).not.toMatch(/безлимит|Stars|купить/i);
    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
  });

  it("подпись «можно?» уводит в проверку без записи", async () => {
    await existingUser();
    tg.clear();
    const upd = photoUpdate();
    (upd.message as { caption?: string }).caption = "можно?";

    await bot.handleUpdate(upd);

    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
    expect(tg.texts()).toContain("Проверка");
  });
});

describe("правка записи", () => {
  it("ответ на карточку пересчитывает приём", async () => {
    await existingUser();
    await bot.handleUpdate(photoUpdate());
    const meal = await prisma.meal.findFirstOrThrow({ where: { userId } });
    const cardMessageId = Number(meal.tgMessageId);
    tg.clear();

    const reply = textUpdate(CHAT, TG, "это была индейка, 200 г");
    (reply.message as { reply_to_message?: unknown }).reply_to_message = {
      message_id: cardMessageId,
      date: 0,
      chat: { id: CHAT, type: "private" }
    };
    await bot.handleUpdate(reply);

    const items = await prisma.mealItem.findMany({ where: { mealId: meal.id } });
    expect(items.map((i) => i.dish)).toEqual(["индейка"]);
    expect(tg.texts()).toContain("Обновил");
  });

  it("кнопка «В мои блюда» сохраняет блюдо один раз", async () => {
    await existingUser();
    await bot.handleUpdate(photoUpdate());
    const meal = await prisma.meal.findFirstOrThrow({ where: { userId } });
    tg.clear();

    await bot.handleUpdate(callbackUpdate(CHAT, TG, `meal:save:${meal.id}`));
    await bot.handleUpdate(callbackUpdate(CHAT, TG, `meal:save:${meal.id}`));

    const recipes = await prisma.recipe.findMany({ where: { userId } });
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.name.toLowerCase()).toContain("куриная грудка");
  });

  it("кнопка удаления убирает запись", async () => {
    await existingUser();
    const meal = await makeMeal(userId);
    tg.clear();

    await bot.handleUpdate(callbackUpdate(CHAT, TG, `meal:del:${meal.id}`));
    expect(await prisma.meal.count({ where: { id: meal.id } })).toBe(0);
  });
});

describe("голосовое сообщение", () => {
  it("расшифровывается и попадает в дневник как еда", async () => {
    await existingUser();
    tg.clear();

    await bot.handleUpdate(voiceUpdate());

    expect(tg.texts()).toContain("тарелка борща");
    expect(await prisma.meal.count({ where: { userId } })).toBe(1);
  });

  it("слишком длинное голосовое отклоняется до расшифровки", async () => {
    await existingUser();
    const { transcribeVoice } = await import("../../ai/food.js");
    tg.clear();

    await bot.handleUpdate(voiceUpdate(90));

    expect(vi.mocked(transcribeVoice)).not.toHaveBeenCalled();
    expect(tg.texts()).toContain("минуту");
  });

  it("сбой расшифровки не теряет сообщение молча", async () => {
    await existingUser();
    const { transcribeVoice } = await import("../../ai/food.js");
    vi.mocked(transcribeVoice).mockRejectedValueOnce(new Error("provider down"));
    tg.clear();

    await bot.handleUpdate(voiceUpdate());

    expect(tg.texts()).toContain("Не расслышал");
    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
  });
});

describe("удаление аккаунта", () => {
  it("требует подтверждения и уносит все записи", async () => {
    await existingUser();
    await makeMeal(userId);
    tg.clear();

    await bot.handleUpdate(textUpdate(CHAT, TG, "/delete"));
    expect(tg.texts()).toContain("удал");
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);

    await bot.handleUpdate(callbackUpdate(CHAT, TG, "acct:del:yes"));
    expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
    expect(await prisma.meal.count({ where: { userId } })).toBe(0);
  });

  it("отказ оставляет аккаунт на месте", async () => {
    await existingUser();
    tg.clear();

    await bot.handleUpdate(textUpdate(CHAT, TG, "/delete"));
    await bot.handleUpdate(callbackUpdate(CHAT, TG, "acct:del:no"));
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
  });
});
