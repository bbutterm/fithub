import { InlineKeyboard } from "grammy";
import { logger } from "../logger.js";
import { bot } from "../bot/bot.js";
import { config } from "../config.js";
import { expireSubscriptions } from "../services/subscription.js";

/** Ежедневно: деактивация истёкших подписок + предложение продлить. */
export async function runSubscriptionExpiryTick(): Promise<void> {
  const expired = await expireSubscriptions();
  const base = `Подписка Pro закончилась 😢 Возвращаю бесплатный тариф: ${config.FREE_PHOTOS_PER_DAY} распознавания в день и советы 2 раза в неделю.`;
  for (const sub of expired) {
    try {
      await bot.api.sendMessage(
        Number(sub.user.tgUserId),
        // С отключённой оплатой не предлагаем продление, которое невозможно оформить
        config.PAYMENTS_ENABLED ? `${base}\n\nПродлить можно в один тап:` : base,
        config.PAYMENTS_ENABLED
          ? {
              reply_markup: new InlineKeyboard()
                .text(`⭐ Месяц — ${config.STARS_PRICE_MONTH} Stars`, "pay:month")
                .text(`⭐ Год — ${config.STARS_PRICE_YEAR} Stars`, "pay:year")
            }
          : undefined
      );
    } catch (err) {
      logger.warn({ err: String(err), userId: sub.userId }, "expiry notice failed");
    }
  }
  if (expired.length) logger.info({ count: expired.length }, "subscriptions expired");
}
