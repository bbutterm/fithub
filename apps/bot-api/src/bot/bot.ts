import { Bot, InlineKeyboard, type Context } from "grammy";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { correctMealItems, NoFoodError, recognizeFoodPhoto, recognizeFoodText, type FoodRecognition } from "../ai/food.js";
import { createMealFromRecognition, deleteMeal, getDay, replaceMealItems } from "../services/meals.js";
import { checkBurstLimit, checkRecognitionLimit, incrementRecognitionCount } from "../services/limits.js";
import { acquireRecognitionLock, releaseRecognitionLock } from "../services/locks.js";
import { calcStreak, getDailyStats } from "../services/stats.js";
import { upsertUserFromTelegram } from "../services/users.js";
import { localDateStr } from "../utils/tz.js";
import { formatDaySummary, formatMealCard } from "./cards.js";
import { checkRateLimit } from "./queue.js";
import { paywallKeyboard, registerPaymentHandlers } from "./payments.js";

export const bot = new Bot(config.BOT_TOKEN);

class RecognitionTimeoutError extends Error {
  constructor() {
    super("recognition timeout");
  }
}

function mealKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard()
    .webApp("✏️ Поправить", `${config.WEBAPP_URL}?meal=${mealId}`)
    .text("🗑 Удалить", `meal:del:${mealId}`)
    .row()
    .webApp("📊 Дневник", config.WEBAPP_URL);
}

const START_TEXT = [
  "Привет! Я твой ИИ-нутрициолог 🥑",
  "",
  "<b>Просто пришли мне фото еды</b> — я определю блюда, посчитаю калории и БЖУ и запишу в дневник.",
  "💡 Подпиши фото названием блюда — распознавание будет точнее.",
  "✏️ Ошибся в распознавании? Ответь на карточку уточнением — пересчитаю.",
  "Можно и текстом: «тарелка борща и два куска хлеба».",
  "",
  "Команды:",
  "/day — сводка за сегодня",
  "/settings — настройки",
  "",
  "Начни с короткого онбординга в приложении, чтобы я рассчитал твои нормы 👇"
].join("\n");

async function handleRecognition(params: {
  ctx: Context;
  recognize: (userId: number) => Promise<FoodRecognition>;
  source: "photo" | "text";
  photoFileId?: string;
  photoThumbFileId?: string;
}): Promise<void> {
  const { ctx } = params;
  if (!ctx.from || !ctx.chat) return;
  const user = await upsertUserFromTelegram(ctx.from);

  if (!checkRateLimit(user.id) || !(await checkBurstLimit(user.id))) {
    await ctx.reply("Слишком много запросов подряд 🙈 Подожди минутку и пришли снова.");
    return;
  }

  const limit = await checkRecognitionLimit(user);
  if (!limit.allowed) {
    await ctx.reply(
      [
        `На бесплатном тарифе — ${limit.limit} распознавания в день, и на сегодня они закончились 😌`,
        "",
        "С <b>Pro</b> распознавания безлимитные, советы приходят каждый день, а аналитика открыта за месяц."
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: paywallKeyboard() }
    );
    return;
  }

  if (!(await acquireRecognitionLock(user.id))) {
    await ctx.reply("Я ещё разбираю предыдущую еду — секунду 🙏");
    return;
  }

  const status = await ctx.reply("Секунду, смотрю… 👀");
  try {
    // Жёсткий бюджет на распознавание: статус-сообщение всегда получает финальный ответ
    // до того, как serverless-функцию убьют по таймауту
    const recognition = await Promise.race([
      params.recognize(user.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RecognitionTimeoutError()), 45_000))
    ]);
    await incrementRecognitionCount(user);
    const meal = await createMealFromRecognition({
      userId: user.id,
      recognition,
      source: params.source,
      photoFileId: params.photoFileId,
      photoThumbFileId: params.photoThumbFileId
    });
    const [profile, day, weekStats] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: user.id } }),
      getDay(user.id, localDateStr(user.tz), user.tz),
      getDailyStats(user.id, user.tz, 14)
    ]);
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      formatMealCard({
        meal,
        dayKcal: day.totals.totalKcal,
        targetKcal: profile?.targetKcal ?? null,
        streak: calcStreak(weekStats)
      }),
      { parse_mode: "HTML", reply_markup: mealKeyboard(meal.id) }
    );
    // Запоминаем message_id карточки: ответ на неё = уточнение распознавания
    await prisma.meal.update({ where: { id: meal.id }, data: { tgMessageId: BigInt(status.message_id) } }).catch(() => undefined);
  } catch (err) {
    const message =
      err instanceof NoFoodError
        ? params.source === "photo"
          ? "Хм, не вижу еды на этом фото 🤔 Попробуй сфотографировать ближе и при хорошем свете."
          : "Не понял, что из еды ты имел в виду 🤔 Опиши подробнее, например: «гречка с курицей, примерно 300 г»."
        : err instanceof RecognitionTimeoutError
          ? "Слишком долго думаю над этим фото 😅 Пришли его ещё раз — обычно со второго раза быстрее."
          : "Не получилось распознать 😔 Попробуй ещё раз через минуту.";
    if (!(err instanceof NoFoodError)) logger.error({ err: String(err), userId: user.id }, "recognition failed");
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, message).catch(() => undefined);
  } finally {
    await releaseRecognitionLock(user.id);
  }
}

/** Уточнение распознавания: пользователь ответил текстом на карточку приёма пищи. */
async function handleCorrection(ctx: Context, userId: number, mealTgMessageId: number, correction: string): Promise<void> {
  if (!ctx.chat) return;
  const meal = await prisma.meal.findFirst({
    where: { userId, tgMessageId: BigInt(mealTgMessageId) },
    include: { items: true }
  });
  if (!meal) return; // ответ не на карточку — игнорируем

  if (!checkRateLimit(userId) || !(await checkBurstLimit(userId))) {
    await ctx.reply("Слишком много запросов подряд 🙈 Подожди минутку.");
    return;
  }
  const status = await ctx.reply("Пересчитываю… ✏️");
  try {
    const recognition = await correctMealItems(meal.items, correction, userId);
    const updated = await replaceMealItems(meal.id, recognition);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const [profile, day, weekStats] = await Promise.all([
      prisma.profile.findUnique({ where: { userId } }),
      getDay(userId, localDateStr(user.tz), user.tz),
      getDailyStats(userId, user.tz, 14)
    ]);
    // Обновляем исходную карточку и убираем статус
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        mealTgMessageId,
        formatMealCard({
          meal: updated,
          dayKcal: day.totals.totalKcal,
          targetKcal: profile?.targetKcal ?? null,
          streak: calcStreak(weekStats)
        }),
        { parse_mode: "HTML", reply_markup: mealKeyboard(meal.id) }
      )
      .catch(() => undefined);
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Обновил ✅ Карточка выше пересчитана.");
  } catch (err) {
    const message =
      err instanceof NoFoodError
        ? "Не понял уточнение 🤔 Напиши, что поменять: «это была индейка», «там было 200 грамм», «добавь хлеб»."
        : "Не получилось пересчитать 😔 Попробуй ещё раз.";
    if (!(err instanceof NoFoodError)) logger.error({ err: String(err), userId }, "correction failed");
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, message).catch(() => undefined);
  }
}

bot.command("start", async (ctx) => {
  if (!ctx.from) return;
  await upsertUserFromTelegram(ctx.from);
  await ctx.reply(START_TEXT, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().webApp("🥗 Открыть приложение", config.WEBAPP_URL)
  });
});

bot.command("day", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
  const day = await getDay(user.id, localDateStr(user.tz), user.tz);
  await ctx.reply(
    formatDaySummary({
      totals: day.totals,
      meals: day.meals,
      targetKcal: profile?.targetKcal ?? null,
      targetProtein: profile?.targetProtein ?? null,
      targetFat: profile?.targetFat ?? null,
      targetCarbs: profile?.targetCarbs ?? null,
      tz: user.tz
    }),
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().webApp("📊 Открыть дневник", config.WEBAPP_URL) }
  );
});

bot.command("settings", async (ctx) => {
  await ctx.reply("Настройки профиля, целей и советов — в приложении:", {
    reply_markup: new InlineKeyboard().webApp("⚙️ Открыть настройки", `${config.WEBAPP_URL}?screen=settings`)
  });
});

bot.callbackQuery(/^meal:del:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const mealId = Number(ctx.match[1]);
  await deleteMeal(mealId, user.id);
  await ctx.answerCallbackQuery({ text: "Удалил 🗑" });
  await ctx.editMessageText("Запись удалена.");
});

registerPaymentHandlers(bot);

bot.on("message:photo", async (ctx) => {
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  if (!largest) return;
  const caption = ctx.message.caption?.trim();
  // Маленький размер (~320px) — для быстрых превью в ленте Mini App
  const thumb = photos.find((p) => p.width >= 250 && p.width <= 500) ?? photos[0];
  const { telegramFileToDataUrl } = await import("../services/tgfiles.js");
  await handleRecognition({
    ctx,
    source: "photo",
    photoFileId: largest.file_id,
    photoThumbFileId: thumb?.file_id,
    // Подпись к фото — подсказка модели: название берём из неё, КБЖУ оцениваем по фото
    recognize: async (userId) => recognizeFoodPhoto(await telegramFileToDataUrl(largest.file_id), userId, caption)
  });
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/") || text.length < 3) return;
  // Ответ на карточку приёма пищи = уточнение распознавания
  const replyTo = ctx.message.reply_to_message;
  if (replyTo && ctx.from) {
    const user = await upsertUserFromTelegram(ctx.from);
    const meal = await prisma.meal.findFirst({
      where: { userId: user.id, tgMessageId: BigInt(replyTo.message_id) },
      select: { id: true }
    });
    if (meal) {
      await handleCorrection(ctx, user.id, replyTo.message_id, text);
      return;
    }
  }
  await handleRecognition({ ctx, source: "text", recognize: (userId) => recognizeFoodText(text, userId) });
});

bot.catch((err) => {
  logger.error({ err: String(err.error) }, "bot error");
});
