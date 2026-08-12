import { InlineKeyboard, type Bot, type Context } from "grammy";
import { config } from "../config.js";
import { PAYMENTS_ENABLED } from "../features.js";
import { logger } from "../logger.js";
import { extendPro } from "../services/subscription.js";
import { upsertUserFromTelegram } from "../services/users.js";

export const PLAN_PAYLOADS = {
  month: { payload: "pro_month", days: 30, title: "Pro на месяц", stars: () => config.STARS_PRICE_MONTH },
  year: { payload: "pro_year", days: 365, title: "Pro на год", stars: () => config.STARS_PRICE_YEAR }
} as const;

/** Клавиатура пейволла. При PAYMENTS_ENABLED=false кнопок покупки нет — только тарифы. */
export function paywallKeyboard(): InlineKeyboard {
  if (!PAYMENTS_ENABLED) {
    return new InlineKeyboard().webApp("📊 Открыть дневник", config.WEBAPP_URL);
  }
  return new InlineKeyboard()
    .text(`⭐ Pro на месяц — ${config.STARS_PRICE_MONTH} Stars`, "pay:month")
    .row()
    .text(`⭐ Pro на год — ${config.STARS_PRICE_YEAR} Stars`, "pay:year")
    .row()
    .webApp("Сравнить тарифы", `${config.WEBAPP_URL}?screen=subscription`);
}

/**
 * Сообщение «лимит на сегодня исчерпан».
 * С отключённой оплатой не зовём в Pro, которое нельзя купить, — просто говорим, когда возвращаться.
 */
export function limitReachedText(limit: number, short = false): string {
  if (!PAYMENTS_ENABLED) {
    return short
      ? `На сегодня распознавания закончились (${limit} в день) 😌 Возвращайся завтра — счётчик обнулится.`
      : [
          `На сегодня распознавания закончились — их ${limit} в день 😌`,
          "",
          "Счётчик обнулится завтра утром. Записи за сегодня никуда не денутся: дневник и аналитика доступны всегда."
        ].join("\n");
  }
  return short
    ? `На бесплатном тарифе — ${limit} распознавания в день, и на сегодня они закончились 😌 С Pro — безлимит.`
    : [
        `На бесплатном тарифе — ${limit} распознавания в день, и на сегодня они закончились 😌`,
        "",
        "С <b>Pro</b> распознавания безлимитные, советы приходят каждый день, а аналитика открыта за месяц."
      ].join("\n");
}

export async function sendProInvoice(ctx: Context, plan: keyof typeof PLAN_PAYLOADS): Promise<void> {
  const p = PLAN_PAYLOADS[plan];
  await ctx.replyWithInvoice(
    p.title,
    plan === "month"
      ? "Безлимит распознаваний, ежедневные советы, месячная аналитика и отчёты."
      : "Всё из Pro на месяц, дешевле в пересчёте на месяц.",
    p.payload,
    "XTR", // Telegram Stars
    [{ label: p.title, amount: p.stars() }]
  );
}

export function registerPaymentHandlers(bot: Bot): void {
  bot.callbackQuery(/^pay:(month|year)$/, async (ctx) => {
    if (!PAYMENTS_ENABLED) {
      await ctx.answerCallbackQuery({ text: "Оплата сейчас отключена", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const plan = ctx.match[1] as keyof typeof PLAN_PAYLOADS;
    await sendProInvoice(ctx, plan);
  });

  // Приём уже начатых платежей остаётся включённым всегда: у пользователя может быть
  // открыт счёт, выставленный до отключения оплаты. Иначе Stars спишутся, а Pro не выдастся.

  bot.on("pre_checkout_query", async (ctx) => {
    const payload = ctx.preCheckoutQuery.invoice_payload;
    const known = Object.values(PLAN_PAYLOADS).some((p) => p.payload === payload);
    await ctx.answerPreCheckoutQuery(known, known ? undefined : "Неизвестный тариф, попробуйте ещё раз.");
  });

  bot.on("message:successful_payment", async (ctx) => {
    const sp = ctx.message.successful_payment;
    const plan = Object.values(PLAN_PAYLOADS).find((p) => p.payload === sp.invoice_payload);
    if (!plan || !ctx.from) return;
    const user = await upsertUserFromTelegram(ctx.from);
    await extendPro(user.id, plan.days, sp.telegram_payment_charge_id);
    logger.info({ userId: user.id, plan: plan.payload, chargeId: sp.telegram_payment_charge_id }, "pro activated");
    await ctx.reply(
      `🎉 Pro активирован! Теперь у тебя безлимит распознаваний, ежедневные советы и полная аналитика.\n\nПодписка действует ${plan.days} дней.`
    );
  });
}
