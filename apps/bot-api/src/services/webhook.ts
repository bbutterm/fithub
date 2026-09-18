import { bot } from "../bot/bot.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Убедиться, что Telegram шлёт апдейты на наш адрес.
 *
 * Webhook снимают как «режим обслуживания» при переездах, и его легко забыть
 * вернуть: бот молча не получает сообщений, а по логам это выглядит как
 * отсутствие пользователей. Проверка идемпотентна и дешёвая — один getWebhookInfo,
 * setWebhook только при расхождении.
 */
export async function ensureWebhook(): Promise<{ changed: boolean; url: string; pending: number }> {
  const expected = `${config.WEBAPP_URL}/api/tg-webhook`;
  const info = await bot.api.getWebhookInfo();
  if (info.url === expected) {
    return { changed: false, url: info.url, pending: info.pending_update_count };
  }
  await bot.api.setWebhook(expected, { secret_token: config.webhookSecret });
  logger.warn({ was: info.url || "(пусто)", now: expected, pending: info.pending_update_count }, "webhook restored");
  return { changed: true, url: expected, pending: info.pending_update_count };
}
