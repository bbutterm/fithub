import { Bot, InlineKeyboard, type Context } from "grammy";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  correctMealItems,
  interpretUserText,
  NoFoodError,
  recognizeFoodPhoto,
  recognizeFoodText,
  transcribeVoice,
  type FoodRecognition
} from "../ai/food.js";
import { createMealFromRecognition, deleteMeal, getDay, replaceMealItems } from "../services/meals.js";
import { checkBurstLimit, checkRecognitionLimit, incrementRecognitionCount } from "../services/limits.js";
import { acquireRecognitionLock, releaseRecognitionLock } from "../services/locks.js";
import { calcStreak, getDailyStats } from "../services/stats.js";
import { upsertUserFromTelegram } from "../services/users.js";
import { addDays, localDateStr, zonedTimeToUtc } from "../utils/tz.js";
import { formatDaySummary, formatMealCard } from "./cards.js";
import { checkRateLimit } from "./queue.js";
import { limitReachedText, paywallKeyboard, registerPaymentHandlers } from "./payments.js";

export const bot = new Bot(config.BOT_TOKEN);

class RecognitionTimeoutError extends Error {
  constructor() {
    super("recognition timeout");
  }
}

/** «ел в 8:30 (вчера)» → UTC-инстант в таймзоне пользователя. */
function eatenTimeToUtc(eaten: { day: "today" | "yesterday"; time: string }, tz: string): Date {
  const date = eaten.day === "yesterday" ? addDays(localDateStr(tz), -1) : localDateStr(tz);
  const time = eaten.time.length === 4 ? `0${eaten.time}` : eaten.time; // "8:30" → "08:30"
  return zonedTimeToUtc(date, time, tz);
}

function mealKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard()
    .webApp("✏️ Поправить", `${config.WEBAPP_URL}?meal=${mealId}`)
    .text("🗑 Удалить", `meal:del:${mealId}`)
    .row()
    .text("🕐 Время", `meal:time:${mealId}`)
    .webApp("📊 Дневник", config.WEBAPP_URL);
}

// Быстрый выбор времени приёма: сдвиги от «сейчас» и типовые часы (локальное время юзера)
function timeKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("−30 мин", `meal:ts:${mealId}:m30`)
    .text("−1 ч", `meal:ts:${mealId}:m60`)
    .text("−2 ч", `meal:ts:${mealId}:m120`)
    .text("−3 ч", `meal:ts:${mealId}:m180`)
    .row()
    .text("Утро 8:00", `meal:ts:${mealId}:p08:00`)
    .text("Обед 13:00", `meal:ts:${mealId}:p13:00`)
    .text("Ужин 19:00", `meal:ts:${mealId}:p19:00`)
    .row()
    .text("↩️ Назад", `meal:tb:${mealId}`);
}

/** Перерисовать карточку приёма (после смены времени/состава). */
async function redrawMealCard(ctx: Context, userId: number, mealId: number, messageId: number): Promise<void> {
  if (!ctx.chat) return;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const meal = await prisma.meal.findFirst({ where: { id: mealId, userId }, include: { items: true } });
  if (!meal) return;
  const [profile, day, weekStats] = await Promise.all([
    prisma.profile.findUnique({ where: { userId } }),
    getDay(userId, localDateStr(user.tz), user.tz),
    getDailyStats(userId, user.tz, 14)
  ]);
  await ctx.api
    .editMessageText(
      ctx.chat.id,
      messageId,
      formatMealCard({
        meal,
        dayKcal: day.totals.totalKcal,
        targetKcal: profile?.targetKcal ?? null,
        streak: calcStreak(weekStats),
        tz: user.tz
      }),
      { parse_mode: "HTML", reply_markup: mealKeyboard(mealId) }
    )
    .catch(() => undefined);
}

const START_TEXT = [
  "Привет! Я твой ИИ-нутрициолог 🥑",
  "",
  "<b>Просто пришли мне фото еды</b> — я определю блюда, посчитаю калории и БЖУ и запишу в дневник.",
  "💡 Подпиши фото названием блюда — распознавание будет точнее.",
  "✏️ Ошибся в распознавании? Ответь на карточку уточнением — пересчитаю.",
  "Можно текстом или голосовым 🎙: «тарелка борща и два куска хлеба».",
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
    await ctx.reply(limitReachedText(limit.limit ?? config.FREE_PHOTOS_PER_DAY), {
      parse_mode: "HTML",
      reply_markup: paywallKeyboard()
    });
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
        streak: calcStreak(weekStats),
        tz: user.tz
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
    if (recognition.items.length > 0) await replaceMealItems(meal.id, recognition);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (recognition.eaten_time) {
      await prisma.meal.update({ where: { id: meal.id }, data: { eatenAt: eatenTimeToUtc(recognition.eaten_time, user.tz) } });
    }
    // Обновляем исходную карточку и убираем статус
    await redrawMealCard(ctx, userId, meal.id, mealTgMessageId);
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

bot.callbackQuery(/^meal:time:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Выбери время — или ответь на карточку: «ел в 8:30»" });
  await ctx.editMessageReplyMarkup({ reply_markup: timeKeyboard(Number(ctx.match[1])) }).catch(() => undefined);
});

bot.callbackQuery(/^meal:tb:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: mealKeyboard(Number(ctx.match[1])) }).catch(() => undefined);
});

bot.callbackQuery(/^meal:ts:(\d+):(m\d+|p\d{2}:\d{2})$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const mealId = Number(ctx.match[1]);
  const choice = ctx.match[2] ?? "";
  const meal = await prisma.meal.findFirst({ where: { id: mealId, userId: user.id }, select: { id: true } });
  if (!meal) {
    await ctx.answerCallbackQuery({ text: "Запись не найдена" });
    return;
  }
  let eatenAt: Date;
  if (choice.startsWith("m")) {
    eatenAt = new Date(Date.now() - Number(choice.slice(1)) * 60_000);
  } else {
    eatenAt = zonedTimeToUtc(localDateStr(user.tz), choice.slice(1), user.tz);
  }
  await prisma.meal.update({ where: { id: mealId }, data: { eatenAt } });
  await ctx.answerCallbackQuery({ text: "Время обновлено 🕐" });
  const messageId = ctx.callbackQuery.message?.message_id;
  if (messageId) await redrawMealCard(ctx, user.id, mealId, messageId);
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

/** Общая маршрутизация текста (набранного или расшифрованного из голосового). */
async function routeFoodText(
  ctx: Context,
  user: Awaited<ReturnType<typeof upsertUserFromTelegram>>,
  text: string,
  replyToMessageId?: number
): Promise<void> {
  // Ответ на карточку приёма пищи = уточнение конкретной записи
  if (replyToMessageId) {
    const meal = await prisma.meal.findFirst({
      where: { userId: user.id, tgMessageId: BigInt(replyToMessageId) },
      select: { id: true }
    });
    if (meal) {
      await handleCorrection(ctx, user.id, replyToMessageId, text);
      return;
    }
  }

  // Есть недавняя запись — модель сама решит: это уточнение («съел половину»),
  // новая еда или сообщение не про еду. Пользователи не делают reply — нужен контекст.
  const lastMeal = await prisma.meal.findFirst({
    where: { userId: user.id, eatenAt: { gte: new Date(Date.now() - 2 * 3600 * 1000) } },
    orderBy: { eatenAt: "desc" },
    include: { items: true }
  });
  if (lastMeal && lastMeal.items.length > 0) {
    await handleContextualText(ctx, user, lastMeal, text);
    return;
  }

  await handleRecognition({ ctx, source: "text", recognize: (userId) => recognizeFoodText(text, userId) });
}

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/") || text.length < 3 || !ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await routeFoodText(ctx, user, text, ctx.message.reply_to_message?.message_id);
});

bot.on("message:voice", async (ctx) => {
  if (!ctx.from || !ctx.chat) return;
  const voice = ctx.message.voice;
  if (voice.duration > 60) {
    await ctx.reply("Голосовое длинновато 🙈 Уложись, пожалуйста, в минуту.");
    return;
  }
  const user = await upsertUserFromTelegram(ctx.from);
  if (!checkRateLimit(user.id) || !(await checkBurstLimit(user.id))) {
    await ctx.reply("Слишком много запросов подряд 🙈 Подожди минутку.");
    return;
  }

  // Расшифровка — платный вызов аудио-модели, поэтому лимит проверяем ДО неё.
  // Исключение: при наличии недавней записи голосовое обычно уточняет её, а уточнения
  // лимит не расходуют (как и текстовые) — такие сообщения пропускаем дальше.
  const voiceLimit = await checkRecognitionLimit(user);
  if (!voiceLimit.allowed) {
    const recentMeal = await prisma.meal.findFirst({
      where: { userId: user.id, eatenAt: { gte: new Date(Date.now() - 2 * 3600 * 1000) } },
      select: { id: true }
    });
    if (!recentMeal) {
      await ctx.reply(limitReachedText(voiceLimit.limit ?? config.FREE_PHOTOS_PER_DAY), {
        parse_mode: "HTML",
        reply_markup: paywallKeyboard()
      });
      return;
    }
  }

  const status = await ctx.reply("Слушаю… 🎙");
  let transcript = "";
  try {
    const { downloadTelegramFile } = await import("../services/tgfiles.js");
    const { buffer } = await downloadTelegramFile(voice.file_id);
    transcript = (await transcribeVoice(buffer.toString("base64"), user.id)).trim();
  } catch (err) {
    logger.error({ err: String(err), userId: user.id }, "voice transcription failed");
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, "Не расслышал 😔 Попробуй ещё раз или напиши текстом.")
      .catch(() => undefined);
    return;
  }
  if (transcript.length < 2) {
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, "Не разобрал слов 🤔 Скажи, что ты съел, например: «тарелка борща и два хлеба».")
      .catch(() => undefined);
    return;
  }
  // Показываем, что услышали (пользователь видит и может поправить), и запускаем обычный конвейер
  await ctx.api.editMessageText(ctx.chat.id, status.message_id, `🎙 «${transcript}»`).catch(() => undefined);
  await routeFoodText(ctx, user, transcript, ctx.message.reply_to_message?.message_id);
});

/** Текст при наличии недавней записи: уточнение последнего приёма / новая еда / не еда. */
async function handleContextualText(
  ctx: Context,
  user: Awaited<ReturnType<typeof upsertUserFromTelegram>>,
  lastMeal: { id: number; eatenAt: Date; tgMessageId: bigint | null; items: Array<{ dish: string; grams: number; kcal: number; protein: number; fat: number; carbs: number }> },
  text: string
): Promise<void> {
  if (!ctx.chat) return;
  if (!checkRateLimit(user.id) || !(await checkBurstLimit(user.id))) {
    await ctx.reply("Слишком много запросов подряд 🙈 Подожди минутку.");
    return;
  }
  if (!(await acquireRecognitionLock(user.id))) {
    await ctx.reply("Секунду, ещё разбираю предыдущее 🙏");
    return;
  }
  const status = await ctx.reply("Секунду… 👀");
  try {
    const minutesAgo = Math.max(1, Math.round((Date.now() - lastMeal.eatenAt.getTime()) / 60000));
    const res = await Promise.race([
      interpretUserText(lastMeal.items, minutesAgo, text, user.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RecognitionTimeoutError()), 45_000))
    ]);

    if (res.action === "correction" && (res.items.length > 0 || res.eaten_time)) {
      if (res.items.length > 0) await replaceMealItems(lastMeal.id, res);
      if (res.eaten_time) {
        await prisma.meal.update({ where: { id: lastMeal.id }, data: { eatenAt: eatenTimeToUtc(res.eaten_time, user.tz) } });
      }
      if (lastMeal.tgMessageId) {
        // Обновляем исходную карточку, статус — короткое подтверждение
        await redrawMealCard(ctx, user.id, lastMeal.id, Number(lastMeal.tgMessageId));
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Обновил ✅ Карточка выше пересчитана.");
      } else {
        await redrawMealCard(ctx, user.id, lastMeal.id, status.message_id);
      }
      return;
    }

    if (res.action === "new_meal" && res.items.length > 0) {
      const limit = await checkRecognitionLimit(user);
      if (!limit.allowed) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          limitReachedText(limit.limit ?? config.FREE_PHOTOS_PER_DAY, true),
          { reply_markup: paywallKeyboard() }
        );
        return;
      }
      await incrementRecognitionCount(user);
      const meal = await createMealFromRecognition({ userId: user.id, recognition: res, source: "text" });
      const [profile, day, weekStats] = await Promise.all([
        prisma.profile.findUnique({ where: { userId: user.id } }),
        getDay(user.id, localDateStr(user.tz), user.tz),
        getDailyStats(user.id, user.tz, 14)
      ]);
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        formatMealCard({ meal, dayKcal: day.totals.totalKcal, targetKcal: profile?.targetKcal ?? null, streak: calcStreak(weekStats), tz: user.tz }),
        { parse_mode: "HTML", reply_markup: mealKeyboard(meal.id) }
      );
      await prisma.meal.update({ where: { id: meal.id }, data: { tgMessageId: BigInt(status.message_id) } }).catch(() => undefined);
      return;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "Не понял 🤔 Опиши еду («гречка с курицей, 300 г») или уточни последнюю запись («съел половину», «это была индейка»)."
    );
  } catch (err) {
    const message =
      err instanceof RecognitionTimeoutError
        ? "Слишком долго думаю 😅 Напиши ещё раз."
        : "Не получилось обработать 😔 Попробуй ещё раз.";
    if (!(err instanceof RecognitionTimeoutError)) logger.error({ err: String(err), userId: user.id }, "contextual text failed");
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, message).catch(() => undefined);
  } finally {
    await releaseRecognitionLock(user.id);
  }
}

bot.catch((err) => {
  logger.error({ err: String(err.error) }, "bot error");
});
