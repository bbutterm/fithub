import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Meal, MealItem } from "@prisma/client";
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
import { applyDietCheck } from "../services/diet.js";
import { getRecipeForUser, listRecipes, logRecipe, saveMealAsRecipe } from "../services/recipes.js";
import {
  activeChallengeOf,
  challengeByCode,
  createChallenge,
  dayNumber,
  historyFacts,
  joinChallenge,
  progressOf,
  quitChallenge,
  ruleOf
} from "../services/challenges.js";
import { assessFeasibility, CHALLENGE_TEMPLATES, describeRule, getTemplate, withValue } from "../challenges.js";
import { checkBurstLimit, checkRecognitionLimit, refundRecognition, tryConsumeRecognition } from "../services/limits.js";
import { acquireRecognitionLock, releaseRecognitionLock } from "../services/locks.js";
import { calcStreak, getDailyStats } from "../services/stats.js";
import { deleteAccount, summarizeAccount, upsertUserFromTelegram } from "../services/users.js";
import { addDays, localDateStr, zonedTimeToUtc } from "../utils/tz.js";
import { formatCheckCard, formatDaySummary, formatMealCard } from "./cards.js";
import { detectCheckIntent } from "./checkIntent.js";
import { nextStepHint } from "../services/nextStep.js";
import { checkMealAgainstDiet } from "../ai/dietCheck.js";
import { logQuickCheck, saveQuickCheck, usualDayEstimate } from "../services/quickCheck.js";
import { sumItems } from "../services/nutrition.js";
import { REMINDER_TEXT } from "./reminderCard.js";
import { checkRateLimit } from "./queue.js";
import { paywallKeyboard, PURCHASES_UNAVAILABLE_TEXT, registerPaymentHandlers } from "./payments.js";

type MealWithItems = Meal & { items: MealItem[] };

export const bot = new Bot(config.BOT_TOKEN);

/** Общий текст при исчерпанном дневном лимите: фото, текст и голосовые. */
function limitReachedText(limit: number): string {
  return [
    `Дневной лимит распознаваний (${limit}) на сегодня исчерпан 😌 Попробуй завтра.`,
    "",
    PURCHASES_UNAVAILABLE_TEXT
  ].join("\n");
}

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
    // Сохранение прямо здесь, а не отдельной формой: ИИ уже разобрал состав,
    // человеку остаётся один тап
    .text("💾 В мои блюда", `meal:save:${mealId}`)
    .row()
    .webApp("📊 Дневник", config.WEBAPP_URL);
}

/** Выбор порции: без множителя сохранённые блюда бесполезны — порции разные. */
function portionKeyboard(recipeId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("½ порции", `rcp:u:${recipeId}:5`)
    .text("1 порция", `rcp:u:${recipeId}:10`)
    .row()
    .text("1½", `rcp:u:${recipeId}:15`)
    .text("2 порции", `rcp:u:${recipeId}:20`)
    .row()
    .text("↩️ К списку", "rcp:list");
}

function recipeListKeyboard(recipes: Array<{ id: number; name: string; kcal: number }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of recipes) {
    kb.text(`${r.name} · ${Math.round(r.kcal)} ккал`, `rcp:p:${r.id}`).row();
  }
  return kb.webApp("📊 Дневник", config.WEBAPP_URL);
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

/**
 * Собрать и отрисовать карточку приёма пищи.
 *
 * Последовательность «взять профиль и итоги дня → сверить с режимом питания →
 * отрисовать» была скопирована в трёх местах: фото, текст без контекста и текст
 * при наличии недавней записи. Из-за этого проверка режима однажды попала в две
 * точки из трёх. Теперь она одна.
 */
async function renderMealCard(
  userId: number,
  tz: string,
  meal: MealWithItems,
  opts: { checkDiet?: boolean } = {}
): Promise<string> {
  const [profile, day, weekStats] = await Promise.all([
    prisma.profile.findUnique({ where: { userId } }),
    getDay(userId, localDateStr(tz), tz),
    getDailyStats(userId, tz, 14)
  ]);
  const checked = opts.checkDiet ? await applyDietCheck(meal, profile) : meal;
  const hourLocal = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())) % 24;
  return formatMealCard({
    meal: checked,
    dayKcal: day.totals.totalKcal,
    targetKcal: profile?.targetKcal ?? null,
    streak: calcStreak(weekStats),
    tz,
    nextStep: profile
      ? nextStepHint({
          hourLocal,
          dayKcal: day.totals.totalKcal,
          dayProtein: day.totals.totalProtein,
          targetKcal: profile.targetKcal,
          targetProtein: profile.targetProtein,
          dietType: profile.dietType
        })
      : null
  });
}

/**
 * Показать карточку только что созданного приёма в статус-сообщении и запомнить
 * его message_id: ответ на карточку = уточнение именно этой записи.
 */
async function publishMealCard(
  ctx: Context,
  user: { id: number; tz: string },
  meal: MealWithItems,
  statusMessageId: number
): Promise<void> {
  if (!ctx.chat) return;
  const text = await renderMealCard(user.id, user.tz, meal, { checkDiet: true });
  await ctx.api.editMessageText(ctx.chat.id, statusMessageId, text, {
    parse_mode: "HTML",
    reply_markup: mealKeyboard(meal.id)
  });
  await prisma.meal
    .update({ where: { id: meal.id }, data: { tgMessageId: BigInt(statusMessageId) } })
    .catch(() => undefined);
}

/** Перерисовать карточку приёма (после смены времени/состава). */
async function redrawMealCard(
  ctx: Context,
  userId: number,
  mealId: number,
  messageId: number,
  // Состав изменился — отметку о диете надо пересчитать, иначе она останется
  // от прошлых блюд. При смене только времени приёма пересчитывать незачем:
  // это лишний платный вызов с тем же результатом.
  opts: { recheckDiet?: boolean } = {}
): Promise<void> {
  if (!ctx.chat) return;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const meal = await prisma.meal.findFirst({ where: { id: mealId, userId }, include: { items: true } });
  if (!meal) return;
  const text = await renderMealCard(userId, user.tz, meal, { checkDiet: opts.recheckDiet });
  await ctx.api
    .editMessageText(ctx.chat.id, messageId, text, { parse_mode: "HTML", reply_markup: mealKeyboard(mealId) })
    .catch(() => undefined);
}

const START_TEXT = [
  "Привет! Я твой ИИ-нутрициолог 🥑",
  "",
  "<b>Просто пришли мне фото еды</b> — я определю блюда, посчитаю калории и БЖУ и запишу в дневник.",
  "💡 Подпиши фото названием блюда — распознавание будет точнее.",
  "✏️ Ошибся в распознавании? Ответь на карточку уточнением — пересчитаю.",
  "💾 Ешь одно и то же? Сохрани блюдо кнопкой под карточкой — потом запишется одним тапом.",
  "Можно текстом или голосовым 🎙: «тарелка борща и два куска хлеба».",
  "❓ Сомневаешься, можно ли тебе это? Подпиши фото «можно?» — сверю с твоим режимом питания и в дневник записывать не буду.",
  "",
  "Команды:",
  "/day — сводка за сегодня",
  "/food — мои блюда: записать привычное одним тапом, без фото",
  "/challenge — челленджи: бот сам проверяет по вашим записям",
  "/settings — настройки",
  "/delete — удалить аккаунт и все записи",
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
    await publishMealCard(ctx, user, meal, status.message_id);
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

function checkKeyboard(checkId: number): InlineKeyboard {
  return new InlineKeyboard().text("📝 Всё-таки записать", `chk:log:${checkId}`);
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

bot.command("start", async (ctx) => {
  if (!ctx.from) return;
  const started = await upsertUserFromTelegram(ctx.from);

  // Приглашение в челлендж: t.me/bot?start=ch_ABC123
  const payload = ctx.match?.toString().trim() ?? "";
  if (payload.startsWith("ch_")) {
    const challenge = await challengeByCode(payload.slice(3));
    if (challenge) {
      const rule = ruleOf(challenge);
      // Выполнимость считаем для ВСТУПАЮЩЕГО, а не для автора: иначе один
      // амбициозный человек приведёт друзей и всех отпугнёт за неделю
      const [profile, history] = await Promise.all([
        prisma.profile.findUnique({ where: { userId: started.id } }),
        historyFacts(started.id, started.tz)
      ]);
      const check = assessFeasibility({
        rule,
        days: challenge.days,
        history,
        profile: profile
          ? { weightKg: profile.weightKg, gender: profile.gender, targetKcal: profile.targetKcal }
          : null
      });
      const joined = await joinChallenge(challenge.id, started.id);
      await ctx.reply(
        [
          joined ? `🎯 Вы в челлендже <b>${challenge.title}</b>` : `🎯 <b>${challenge.title}</b>`,
          "",
          describeRule(rule),
          `Срок: ${challenge.days} дней.`,
          check.reason ? `\n${check.reason}` : "",
          joined ? "\nИтог дня буду присылать вечером." : "\nСначала завершите текущий челлендж — /challenge"
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }
  }

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

bot.callbackQuery(/^meal:save:(\d+)$/, async (ctx) => {
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

/** Список сохранённых блюд. Повтор отсюда не стоит ни одного вызова ИИ. */
async function showRecipeList(ctx: Context, userId: number, edit: boolean): Promise<void> {
  const recipes = await listRecipes(userId, 8);
  if (recipes.length === 0) {
    const text =
      "Сохранённых блюд пока нет.\n\n" +
      "Пришлите фото еды, и под карточкой будет кнопка <b>💾 В мои блюда</b>. " +
      "Потом такое же блюдо записывается одним тапом — без фото и мгновенно.";
    if (edit) await ctx.editMessageText(text, { parse_mode: "HTML" }).catch(() => undefined);
    else await ctx.reply(text, { parse_mode: "HTML" });
    return;
  }
  const text = "🍲 <b>Мои блюда</b>\n\nВыберите — запишу в дневник без фото и распознавания.";
  const markup = recipeListKeyboard(recipes);
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: markup }).catch(() => undefined);
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
}

bot.command("food", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await showRecipeList(ctx, user.id, false);
});

bot.callbackQuery("rcp:list", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  const user = await upsertUserFromTelegram(ctx.from);
  await showRecipeList(ctx, user.id, true);
});

bot.callbackQuery(/^rcp:p:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const recipe = await getRecipeForUser(Number(ctx.match[1]), user.id);
  if (!recipe) {
    await ctx.answerCallbackQuery({ text: "Блюдо не найдено" });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx
    .editMessageText(
      `🍲 <b>${recipe.name}</b>\n\nПорция ${Math.round(recipe.portionGrams)} г · ${Math.round(recipe.kcal)} ккал ` +
        `(Б ${Math.round(recipe.protein)} / Ж ${Math.round(recipe.fat)} / У ${Math.round(recipe.carbs)})\n\nСколько съели?`,
      { parse_mode: "HTML", reply_markup: portionKeyboard(recipe.id) }
    )
    .catch(() => undefined);
});

bot.callbackQuery(/^rcp:u:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.from || !ctx.chat) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const recipe = await getRecipeForUser(Number(ctx.match[1]), user.id);
  if (!recipe) {
    await ctx.answerCallbackQuery({ text: "Блюдо не найдено" });
    return;
  }
  const multiplier = Number(ctx.match[2]) / 10;
  await ctx.answerCallbackQuery({ text: "Записываю…" });
  // Лимит распознаваний не расходуется: вызова модели здесь нет, платить не за что
  const meal = await logRecipe(recipe, multiplier);
  const messageId = ctx.callbackQuery.message?.message_id;
  if (messageId) await publishMealCard(ctx, user, meal, messageId);
});


// --- Челленджи ---

function templatesKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of CHALLENGE_TEMPLATES) kb.text(t.title, `ch:t:${t.id}`).row();
  return kb;
}

/** Карточка активного челленджа: где человек находится и сколько осталось. */
async function showActiveChallenge(ctx: Context, userId: number, tz: string): Promise<boolean> {
  const part = await activeChallengeOf(userId);
  if (!part) return false;
  const ch = part.challenge;
  const today = localDateStr(tz);
  const dayNo = dayNumber(ch, today);
  const progress = await progressOf(ch.id, userId, ch.days);
  const notStarted = dayNo < 1;

  const lines = [
    `🎯 <b>${ch.title}</b>`,
    "",
    describeRule(ruleOf(ch)),
    notStarted ? `Старт завтра, ${ch.startDate}.` : `День ${Math.min(dayNo, ch.days)} из ${ch.days}.`,
    `Засчитано: <b>${progress.passed}</b>${progress.frozen ? ` · заморозок использовано: ${progress.frozen}` : ""}`,
    `Заморозок осталось: ${part.jokersLeft}`,
    "",
    "Итог дня приходит вечером — считать ничего не нужно, я смотрю по вашим записям.",
    "",
    `Позвать друга: <code>t.me/${(ctx.me?.username ?? "bot")}?start=ch_${ch.joinCode}</code>`
  ];
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("Бросить челлендж", `ch:quit:${ch.id}`)
  });
  return true;
}

bot.command("challenge", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  if (await showActiveChallenge(ctx, user.id, user.tz)) return;
  await ctx.reply(
    [
      "🎯 <b>Челленджи</b>",
      "",
      "Выберите челлендж — я буду сам проверять его по вашим записям и присылать итог каждый вечер.",
      "Отмечать ничего не нужно.",
      "",
      "Одновременно идёт один челлендж: три сразу — это ноль выполненных."
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: templatesKeyboard() }
  );
});

bot.callbackQuery(/^ch:t:(\w+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const template = getTemplate(ctx.match[1] ?? "");
  if (!template) {
    await ctx.answerCallbackQuery({ text: "Челлендж не найден" });
    return;
  }
  await ctx.answerCallbackQuery();

  // Выполнимость считаем по его собственным записям: абстрактную норму человек
  // проигнорирует, свои цифры — заметно реже
  const [profile, history] = await Promise.all([
    prisma.profile.findUnique({ where: { userId: user.id } }),
    historyFacts(user.id, user.tz)
  ]);
  const check = assessFeasibility({
    rule: template.rule,
    days: template.days,
    history,
    profile: profile
      ? { weightKg: profile.weightKg, gender: profile.gender, targetKcal: profile.targetKcal }
      : null
  });

  const lines = [`🎯 <b>${template.title}</b>`, "", describeRule(template.rule), `Срок: ${template.days} дней.`];
  if (check.reason) lines.push("", check.reason);

  if (check.verdict === "refuse") {
    await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: templatesKeyboard() }).catch(() => undefined);
    return;
  }

  const kb = new InlineKeyboard();
  if (check.verdict === "risky" && check.suggestedValue !== undefined) {
    kb.text(`Взять ${check.suggestedValue}`, `ch:s:${template.id}:${check.suggestedValue}`).row();
    kb.text("Всё равно как есть", `ch:s:${template.id}:0`).row();
  } else {
    kb.text("Начать", `ch:s:${template.id}:0`).row();
  }
  kb.text("↩️ К списку", "ch:list");
  lines.push("", "Старт — с завтрашнего дня: сегодняшний уже наполовину прошёл.");
  await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined);
});

bot.callbackQuery("ch:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx
    .editMessageText("🎯 <b>Челленджи</b>\n\nВыберите — я буду проверять его сам по вашим записям.", {
      parse_mode: "HTML",
      reply_markup: templatesKeyboard()
    })
    .catch(() => undefined);
});

bot.callbackQuery(/^ch:s:(\w+):(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const template = getTemplate(ctx.match[1] ?? "");
  if (!template) {
    await ctx.answerCallbackQuery({ text: "Челлендж не найден" });
    return;
  }
  if (await activeChallengeOf(user.id)) {
    await ctx.answerCallbackQuery({ text: "У вас уже идёт челлендж", show_alert: true });
    return;
  }
  const override = Number(ctx.match[2]);
  const rule = override > 0 ? withValue(template.rule, override) : template.rule;
  const challenge = await createChallenge({
    ownerId: user.id,
    title: template.title,
    rule,
    days: template.days,
    tz: user.tz
  });
  await ctx.answerCallbackQuery({ text: "Поехали!" });
  await ctx
    .editMessageText(
      [
        `🎯 <b>${challenge.title}</b> — стартует завтра`,
        "",
        describeRule(rule),
        `Срок: ${challenge.days} дней. Заморозка: 1 — на случай сорванного дня.`,
        "",
        "Каждый вечер пришлю итог дня. Отмечать ничего не нужно: я смотрю по вашим записям о еде.",
        "",
        `Позвать друга: <code>t.me/${ctx.me?.username ?? "bot"}?start=ch_${challenge.joinCode}</code>`
      ].join("\n"),
      { parse_mode: "HTML" }
    )
    .catch(() => undefined);
});

bot.callbackQuery(/^ch:quit:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await quitChallenge(Number(ctx.match[1]), user.id);
  await ctx.answerCallbackQuery({ text: "Челлендж закрыт" });
  await ctx.editMessageText("Челлендж закрыт. Новый — /challenge").catch(() => undefined);
});

bot.command("delete", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const summary = await summarizeAccount(user.id);
  if (!summary) return;
  const lines = [
    "🗑 <b>Удаление аккаунта</b>",
    "",
    "Будут удалены безвозвратно:",
    `• записей о еде: <b>${summary.meals}</b>`,
    `• советов и отчётов: <b>${summary.advices}</b>`,
    summary.hasProfile ? "• профиль: пол, возраст, рост, вес, цели, аллергии, режим питания" : null,
    "",
    "Отменить это будет нельзя. Экспорта пока нет — если данные нужны, сначала сохраните их из дневника."
  ].filter(Boolean) as string[];
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("Удалить всё", "acct:del:yes")
      .row()
      .text("Отмена", "acct:del:no")
  });
});

bot.callbackQuery("acct:del:no", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Отменено" });
  await ctx.editMessageText("Ничего не удалил — всё на месте 🙂").catch(() => undefined);
});

bot.callbackQuery("acct:del:yes", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await deleteAccount(user.id);
  logger.info({ userId: user.id }, "account deleted by user");
  await ctx.answerCallbackQuery({ text: "Удалено" });
  await ctx.editMessageText(
    "Аккаунт и все записи удалены. Если захотите начать заново — просто пришлите мне фото еды."
  ).catch(() => undefined);
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

// Проверка «можно?» → всё-таки записать в дневник (без повторного распознавания)
bot.callbackQuery(/^chk:log:(\d+)$/, async (ctx) => {
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

// Вечернее напоминание: «ел как обычно» — запись по среднему за прошлые дни
bot.callbackQuery("rem:usual", async (ctx) => {
  if (!ctx.from || !ctx.chat) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const today = localDateStr(user.tz);
  const { meals } = await getDay(user.id, today, user.tz);
  if (meals.length > 0) {
    await ctx.answerCallbackQuery({ text: "Сегодня уже есть записи 🙂" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    return;
  }
  const usual = await usualDayEstimate(user.id, user.tz);
  if (!usual) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${REMINDER_TEXT}\n\n🤷 Пока не знаю, что для тебя «обычно»: нужно хотя бы два дня с записями. Опиши сегодняшнюю еду текстом одной строкой — этого хватит.`
    ).catch(() => undefined);
    return;
  }
  const meal = await createMealFromRecognition({
    userId: user.id,
    source: "manual",
    // Полдень, а не момент нажатия: иначе каждый такой день выглядел бы как поздний ужин
    eatenAt: zonedTimeToUtc(today, "13:00", user.tz),
    recognition: {
      items: [
        {
          dish: `Обычный день (≈ среднее за ${usual.days} дн.)`,
          grams: 0,
          kcal: usual.kcal,
          protein: usual.protein,
          fat: usual.fat,
          carbs: usual.carbs,
          confidence: 0.5
        }
      ],
      comment: "Записано по среднему за твои прошлые дни. Если сегодня было иначе — ответь на это сообщение, поправлю.",
      overall_confidence: 0.5
    }
  });
  await ctx.answerCallbackQuery({ text: "Записал по среднему ✅" });
  await ctx.editMessageText(`${REMINDER_TEXT}\n\n✅ Записал по среднему.`).catch(() => undefined);
  const text = await renderMealCard(user.id, user.tz, meal, { checkDiet: false });
  const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: mealKeyboard(meal.id) });
  await prisma.meal.update({ where: { id: meal.id }, data: { tgMessageId: BigInt(sent.message_id) } }).catch(() => undefined);
});

bot.callbackQuery("rem:later", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Жду 📷" });
  await ctx.editMessageText(`${REMINDER_TEXT}\n\n📷 Жду фото или пару слов о еде.`).catch(() => undefined);
});

bot.callbackQuery("rem:off", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await prisma.profile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, reminderEnabled: false },
    update: { reminderEnabled: false }
  });
  await ctx.answerCallbackQuery({ text: "Больше не буду напоминать" });
  await ctx.editMessageText("🔕 Вечерние напоминания выключены. Включить обратно можно в настройках приложения.").catch(() => undefined);
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

bot.catch((err) => {
  logger.error({ err: String(err.error) }, "bot error");
});
