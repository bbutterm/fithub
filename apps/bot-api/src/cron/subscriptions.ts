import { logger } from "../logger.js";
import { bot } from "../bot/bot.js";
import { paywallKeyboard } from "../bot/payments.js";
import { expireSubscriptions } from "../services/subscription.js";

/** Ежедневно: деактивация истёкших подписок и уведомление о статусе. */
export async function runSubscriptionExpiryTick(): Promise<void> {
  const expired = await expireSubscriptions();
  for (const sub of expired) {
    try {
      await bot.api.sendMessage(
        Number(sub.user.tgUserId),
        "Подписка Pro закончилась. Теперь действует бесплатный тариф.\n\nПокупки и продление Pro сейчас недоступны. Лимит распознаваний можно проверить в статусе подписки.",
        {
          reply_markup: paywallKeyboard()
        }
      );
    } catch (err) {
      logger.warn({ err: String(err), userId: sub.userId }, "expiry notice failed");
    }
  }
  if (expired.length) logger.info({ count: expired.length }, "subscriptions expired");
}
