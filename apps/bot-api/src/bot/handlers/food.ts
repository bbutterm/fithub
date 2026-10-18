import { Composer, type Context } from "grammy";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import {
  correctMealItems,
  interpretUserText,
  NoFoodError,
  recognizeFoodPhoto,
  recognizeFoodText,
  transcribeVoice,
  type FoodRecognition
} from "../../ai/food.js";
import { checkMealAgainstDiet } from "../../ai/dietCheck.js";
import { createMealFromRecognition, deleteMeal, replaceMealItems } from "../../services/meals.js";
import { logQuickCheck, saveQuickCheck } from "../../services/quickCheck.js";
import { saveMealAsRecipe } from "../../services/recipes.js";
import { sumItems } from "../../services/nutrition.js";
import { checkBurstLimit, checkRecognitionLimit, refundRecognition, tryConsumeRecognition } from "../../services/limits.js";
import { acquireRecognitionLock, releaseRecognitionLock } from "../../services/locks.js";
import { upsertUserFromTelegram } from "../../services/users.js";
import { formatCheckCard } from "../cards.js";
import { detectCheckIntent } from "../checkIntent.js";
import { eatenTimeToUtc, limitReachedText, RecognitionTimeoutError } from "../helpers.js";
import { checkKeyboard, mealKeyboard, timeKeyboard } from "../keyboards.js";
import { publishMealCard, redrawMealCard, renderMealCard } from "../mealCard.js";
import { localDateStr, zonedTimeToUtc } from "../../utils/tz.js";
import { checkRateLimit } from "../queue.js";
import { paywallKeyboard } from "../payments.js";

/** Всё, что относится к еде: фото, текст, голос, уточнения и проверка «можно?». */
export const foodComposer = new Composer<Context>();

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

  // Занимаем попытку одним запросом: проверка и списание неразделимы, иначе два
  // сообщения подряд проходят оба. Если дальше сорвётся — вернём через refund.
  const limit = await tryConsumeRecognition(user);
  if (!limit.allowed) {
    await ctx.reply(limitReachedText(limit.limit ?? config.FREE_PHOTOS_PER_DAY), {
      parse_mode: "HTML",
      reply_markup: paywallKeyboard()
    });
    return;
  }

  if (!(await acquireRecognitionLock(user.id))) {
    await refundRecognition(user);
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
    const meal = await createMealFromRecognition({
      userId: user.id,
      recognition,
      source: params.source,
      photoFileId: params.photoFileId,
      photoThumbFileId: params.photoThumbFileId
    });
    // Отрисовка карточки отделена от распознавания: еда уже записана, и сбой
    // при сборке карточки (недоступная проверка режима, запнувшаяся база) не
    // должен выглядеть как «не получилось распознать» и возвращать попытку —
    // запись при этом молча оставалась в дневнике без карточки и без права
    // поправить её ответом.
    try {
      await publishMealCard(ctx, user, meal, status.message_id);
    } catch (err) {
      logger.error({ err: String(err), userId: user.id, mealId: meal.id }, "meal card render failed");
      const totals = `${Math.round(meal.totalKcal)} ккал · Б ${Math.round(meal.totalProtein)} / Ж ${Math.round(meal.totalFat)} / У ${Math.round(meal.totalCarbs)}`;
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, `Записал приём пищи: ${totals}.\nКарточку показать не смог — загляни в дневник.`)
        .catch(() => undefined);
    }
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
    // Еда не распознана или провайдер не ответил — попытка не должна сгорать
    await refundRecognition(user);
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, message).catch(() => undefined);
  } finally {
    await releaseRecognitionLock(user.id);
  }
}


/**
 * Режим «можно?»: распознать еду и сверить с режимом питания, НЕ записывая в дневник.
 *
 * Тот же платный вызов модели, что и при записи, поэтому лимиты и блокировки те
 * же. Отличие одно: вместо приёма пищи сохраняется проверка, а под ответом
 * кнопка «записать» — на случай, если человек всё же это съел.
 */
async function handleQuickCheck(params: {
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
  const limit = await tryConsumeRecognition(user);
  if (!limit.allowed) {
    await ctx.reply(limitReachedText(limit.limit ?? config.FREE_PHOTOS_PER_DAY), {
      parse_mode: "HTML",
      reply_markup: paywallKeyboard()
    });
    return;
  }
  if (!(await acquireRecognitionLock(user.id))) {
    await refundRecognition(user);
    await ctx.reply("Я ещё разбираю предыдущую еду — секунду 🙏");
    return;
  }

  const status = await ctx.reply("Смотрю, что это и можно ли тебе… 🔎");
  try {
    const recognition = await Promise.race([
      params.recognize(user.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RecognitionTimeoutError()), 45_000))
    ]);
    if (recognition.items.length === 0) throw new NoFoodError();

    const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
    const hasDiet = Boolean(profile && (profile.medicalDiets.length > 0 || profile.dietNotes?.trim() || profile.allergies.length > 0));
    const verdict = await checkMealAgainstDiet({
      dishes: recognition.items.map((i) => `${i.dish} — ${Math.round(i.grams)} г`),
      profile,
      userId: user.id
    });
    const checkId = await saveQuickCheck({
      userId: user.id,
      recognition,
      source: params.source,
      photoFileId: params.photoFileId,
      photoThumbFileId: params.photoThumbFileId,
      dietNote: verdict?.note ?? null,
      dietVerdict: verdict?.verdict ?? null
    });
    const text = formatCheckCard({
      items: recognition.items,
      totals: sumItems(recognition.items),
      dietNote: verdict?.note ?? null,
      dietVerdict: verdict?.verdict ?? null,
      hasDiet,
      comment: recognition.comment
    });
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, text, {
      parse_mode: "HTML",
      reply_markup: checkKeyboard(checkId)
    });
  } catch (err) {
    const message =
      err instanceof NoFoodError
        ? params.source === "photo"
          ? "Хм, не вижу еды на этом фото 🤔 Попробуй сфотографировать ближе и при хорошем свете."
          : "Не понял, о какой еде речь 🤔 Напиши конкретнее: «можно мне жареную картошку?»."
        : err instanceof RecognitionTimeoutError
          ? "Слишком долго думаю 😅 Пришли ещё раз — обычно со второго раза быстрее."
          : "Не получилось проверить 😔 Попробуй ещё раз через минуту.";
    if (!(err instanceof NoFoodError)) logger.error({ err: String(err), userId: user.id }, "quick check failed");
    await refundRecognition(user);
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
    await redrawMealCard(ctx, userId, meal.id, mealTgMessageId, { recheckDiet: recognition.items.length > 0 });
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


foodComposer.callbackQuery(/^meal:save:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const meal = await prisma.meal.findFirst({
    where: { id: Number(ctx.match[1]), userId: user.id },
    include: { items: true }
  });
  if (!meal || meal.items.length === 0) {
    await ctx.answerCallbackQuery({ text: "Запись не найдена" });
    return;
  }
  const { recipe, updated } = await saveMealAsRecipe(meal);
  await ctx.answerCallbackQuery({
    text: `${updated ? "Обновил" : "Сохранил"}: ${recipe.name}. Повторить — /food`,
    show_alert: false
  });
});


foodComposer.callbackQuery(/^meal:time:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Выбери время — или ответь на карточку: «ел в 8:30»" });
  await ctx.editMessageReplyMarkup({ reply_markup: timeKeyboard(Number(ctx.match[1])) }).catch(() => undefined);
});

foodComposer.callbackQuery(/^meal:tb:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: mealKeyboard(Number(ctx.match[1])) }).catch(() => undefined);
});

foodComposer.callbackQuery(/^meal:ts:(\d+):(m\d+|p\d{2}:\d{2})$/, async (ctx) => {
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

foodComposer.callbackQuery(/^chk:log:(\d+)$/, async (ctx) => {
  if (!ctx.from || !ctx.chat) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const meal = await logQuickCheck(Number(ctx.match[1]), user.id);
  if (!meal) {
    await ctx.answerCallbackQuery({ text: "Эта проверка устарела — пришли фото ещё раз", show_alert: true });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    return;
  }
  await ctx.answerCallbackQuery({ text: "Записал ✅" });
  const messageId = ctx.callbackQuery.message?.message_id;
  if (!messageId) return;
  const text = await renderMealCard(user.id, user.tz, meal, { checkDiet: false });
  await ctx.api
    .editMessageText(ctx.chat.id, messageId, text, { parse_mode: "HTML", reply_markup: mealKeyboard(meal.id) })
    .catch(() => undefined);
  await prisma.meal.update({ where: { id: meal.id }, data: { tgMessageId: BigInt(messageId) } }).catch(() => undefined);
});

foodComposer.callbackQuery(/^meal:del:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const mealId = Number(ctx.match[1]);
  await deleteMeal(mealId, user.id);
  await ctx.answerCallbackQuery({ text: "Удалил 🗑" });
  await ctx.editMessageText("Запись удалена.");
});

foodComposer.on("message:photo", async (ctx) => {
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  if (!largest) return;
  const caption = ctx.message.caption?.trim();
  // Маленький размер (~320px) — для быстрых превью в ленте Mini App
  const thumb = photos.find((p) => p.width >= 250 && p.width <= 500) ?? photos[0];
  const { telegramFileToDataUrl } = await import("../../services/tgfiles.js");
  // «можно?» в подписи — вопрос, а не запись: проверяем по режиму, дневник не трогаем
  const intent = detectCheckIntent(caption);
  if (intent.check) {
    await handleQuickCheck({
      ctx,
      source: "photo",
      photoFileId: largest.file_id,
      photoThumbFileId: thumb?.file_id,
      recognize: async (userId) =>
        recognizeFoodPhoto(await telegramFileToDataUrl(largest.file_id), userId, intent.hint ?? undefined)
    });
    return;
  }
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
  const hasRecent = Boolean(lastMeal && lastMeal.items.length > 0);

  // Вопрос «можно мне …?» — проверка без записи. Одного знака «?» рядом с
  // недавней записью мало: «там точно 300 грамм?» — это уточнение, не вопрос о новой еде.
  const intent = detectCheckIntent(text);
  if (intent.check && (intent.strong || !hasRecent)) {
    const query = intent.hint ?? text;
    await handleQuickCheck({ ctx, source: "text", recognize: (userId) => recognizeFoodText(query, userId) });
    return;
  }

  if (lastMeal && hasRecent) {
    await handleContextualText(ctx, user, lastMeal, text);
    return;
  }

  await handleRecognition({ ctx, source: "text", recognize: (userId) => recognizeFoodText(text, userId) });
}

foodComposer.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/") || text.length < 3 || !ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await routeFoodText(ctx, user, text, ctx.message.reply_to_message?.message_id);
});


foodComposer.on("message:voice", async (ctx) => {
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
    const { downloadTelegramFile } = await import("../../services/tgfiles.js");
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
        await redrawMealCard(ctx, user.id, lastMeal.id, Number(lastMeal.tgMessageId), { recheckDiet: res.items.length > 0 });
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Обновил ✅ Карточка выше пересчитана.");
      } else {
        await redrawMealCard(ctx, user.id, lastMeal.id, status.message_id, { recheckDiet: res.items.length > 0 });
      }
      return;
    }

    if (res.action === "new_meal" && res.items.length > 0) {
      const limit = await tryConsumeRecognition(user);
      if (!limit.allowed) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          limitReachedText(limit.limit ?? config.FREE_PHOTOS_PER_DAY),
          { reply_markup: paywallKeyboard() }
        );
        return;
      }
      const meal = await createMealFromRecognition({
        userId: user.id,
        recognition: res,
        source: "text",
        // «на завтрак в 8:00 ел овсянку» — модель возвращает eaten_time и для новой еды,
        // а не только для уточнений; раньше оно здесь молча терялось
        eatenAt: res.eaten_time ? eatenTimeToUtc(res.eaten_time, user.tz) : undefined
      });
      await publishMealCard(ctx, user, meal, status.message_id);
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

