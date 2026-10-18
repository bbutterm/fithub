import { Composer, InlineKeyboard, type Context } from "grammy";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { assessFeasibility, describeRule } from "../../challenges.js";
import { createMealFromRecognition, getDay } from "../../services/meals.js";
import { challengeByCode, historyFacts, joinChallenge, ruleOf } from "../../services/challenges.js";
import { usualDayEstimate } from "../../services/quickCheck.js";
import { deleteAccount, summarizeAccount, upsertUserFromTelegram } from "../../services/users.js";
import { localDateStr, zonedTimeToUtc } from "../../utils/tz.js";
import { formatDaySummary } from "../cards.js";
import { mealKeyboard } from "../keyboards.js";
import { renderMealCard } from "../mealCard.js";
import { REMINDER_TEXT } from "../reminderCard.js";

/** Знакомство, сводка дня, настройки, удаление аккаунта и вечернее напоминание. */
export const accountComposer = new Composer<Context>();

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


accountComposer.command("start", async (ctx) => {
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


accountComposer.command("day", async (ctx) => {
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


accountComposer.command("settings", async (ctx) => {
  await ctx.reply("Настройки профиля, целей и советов — в приложении:", {
    reply_markup: new InlineKeyboard().webApp("⚙️ Открыть настройки", `${config.WEBAPP_URL}?screen=settings`)
  });
});


accountComposer.command("delete", async (ctx) => {
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

accountComposer.callbackQuery("acct:del:no", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Отменено" });
  await ctx.editMessageText("Ничего не удалил — всё на месте 🙂").catch(() => undefined);
});

accountComposer.callbackQuery("acct:del:yes", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await deleteAccount(user.id);
  logger.info({ userId: user.id }, "account deleted by user");
  await ctx.answerCallbackQuery({ text: "Удалено" });
  await ctx.editMessageText(
    "Аккаунт и все записи удалены. Если захотите начать заново — просто пришлите мне фото еды."
  ).catch(() => undefined);
});


accountComposer.callbackQuery("rem:usual", async (ctx) => {
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

accountComposer.callbackQuery("rem:later", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Жду 📷" });
  await ctx.editMessageText(`${REMINDER_TEXT}\n\n📷 Жду фото или пару слов о еде.`).catch(() => undefined);
});

accountComposer.callbackQuery("rem:off", async (ctx) => {
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

