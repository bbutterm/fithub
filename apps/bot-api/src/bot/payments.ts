import { InlineKeyboard, type Bot, type Context } from "grammy";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extendPro } from "../services/subscription.js";
import { upsertUserFromTelegram } from "../services/users.js";

export const PLAN_PAYLOADS = {
  month: { payload: "pro_month", days: 30, title: "Pro на месяц", stars: () => config.STARS_PRICE_MONTH },
  year: { payload: "pro_year", days: 365, title: "Pro на год", stars: () => config.STARS_PRICE_YEAR }
} as const;

export const PURCHASES_UNAVAILABLE_TEXT =
  "Покупки и продление Pro сейчас недоступны. Действующие подписки сохраняются до конца своего срока.";

export function paywallKeyboard(): InlineKeyboard {
  return new InlineKeyboard().webApp("Статус подписки", `${config.WEBAPP_URL}?screen=subscription`);
}

// Сигнатура сохранена для старых кнопок pay:month / pay:year.
export async function sendProInvoice(ctx: Context, _plan: keyof typeof PLAN_PAYLOADS): Promise<void> {
  await ctx.reply(PURCHASES_UNAVAILABLE_TEXT);
}

export function registerPaymentHandlers(bot: Bot): void {
  bot.command("pro", async (ctx) => {
    await ctx.reply(PURCHASES_UNAVAILABLE_TEXT, { reply_markup: paywallKeyboard() });
  });

  bot.callbackQuery(/^pay:(month|year)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const plan = ctx.match[1] as keyof typeof PLAN_PAYLOADS;
    await sendProInvoice(ctx, plan);
  });

  bot.on("pre_checkout_query", async (ctx) => {
    // Блокируем и счета, созданные до паузы: payload не даёт права на оплату.
    await ctx.answerPreCheckoutQuery(false, "Покупки и продление Pro сейчас недоступны.");
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
