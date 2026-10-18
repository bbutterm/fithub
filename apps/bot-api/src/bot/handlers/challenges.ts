import { Composer, InlineKeyboard, type Context } from "grammy";
import { prisma } from "../../db.js";
import {
  activeChallengeOf,
  createChallenge,
  dayNumber,
  historyFacts,
  progressOf,
  quitChallenge,
  ruleOf
} from "../../services/challenges.js";
import { assessFeasibility, describeRule, getTemplate, withValue } from "../../challenges.js";
import { upsertUserFromTelegram } from "../../services/users.js";
import { localDateStr } from "../../utils/tz.js";
import { templatesKeyboard } from "../keyboards.js";

/** Челленджи: выбор шаблона, проверка выполнимости, старт и выход. */
export const challengesComposer = new Composer<Context>();

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

challengesComposer.command("challenge", async (ctx) => {
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

challengesComposer.callbackQuery(/^ch:t:(\w+)$/, async (ctx) => {
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

challengesComposer.callbackQuery("ch:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx
    .editMessageText("🎯 <b>Челленджи</b>\n\nВыберите — я буду проверять его сам по вашим записям.", {
      parse_mode: "HTML",
      reply_markup: templatesKeyboard()
    })
    .catch(() => undefined);
});

challengesComposer.callbackQuery(/^ch:s:(\w+):(\d+)$/, async (ctx) => {
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

challengesComposer.callbackQuery(/^ch:quit:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await quitChallenge(Number(ctx.match[1]), user.id);
  await ctx.answerCallbackQuery({ text: "Челлендж закрыт" });
  await ctx.editMessageText("Челлендж закрыт. Новый — /challenge").catch(() => undefined);
});

