import { Bot } from "grammy";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { accountComposer } from "./handlers/account.js";
import { challengesComposer } from "./handlers/challenges.js";
import { foodComposer } from "./handlers/food.js";
import { recipesComposer } from "./handlers/recipes.js";
import { registerPaymentHandlers } from "./payments.js";

/**
 * Сборка бота из частей.
 *
 * Обработчики разложены по областям разговора (аккаунт, блюда, челленджи, еда),
 * а здесь только порядок их подключения. Порядок важен: у части с едой есть
 * обработчики «любое фото» и «любой текст», и они должны стоять последними,
 * иначе перехватят команды и кнопки остальных частей.
 */
export const bot = new Bot(config.BOT_TOKEN);

registerPaymentHandlers(bot);
bot.use(accountComposer);
bot.use(recipesComposer);
bot.use(challengesComposer);
bot.use(foodComposer);

bot.catch((err) => {
  logger.error({ err: String(err.error) }, "bot error");
});

