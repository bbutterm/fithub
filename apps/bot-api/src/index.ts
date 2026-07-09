import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { bot } from "./bot/bot.js";
import { buildServer } from "./api/server.js";
import { startCronJobs } from "./cron/index.js";

async function main(): Promise<void> {
  const app = await buildServer();
  // SKIP_BOT_LAUNCH=1 — dev-режим: поднять только API без подключения к Telegram
  const skipBot = process.env.SKIP_BOT_LAUNCH === "1";

  if (!skipBot && config.BOT_WEBHOOK_URL) {
    // Prod (self-hosted): маршрут /api/tg-webhook уже зарегистрирован в buildServer
    await bot.api.setWebhook(config.BOT_WEBHOOK_URL, { secret_token: config.webhookSecret });
    logger.info({ url: config.BOT_WEBHOOK_URL }, "bot in webhook mode");
  }

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ port: config.PORT }, "api server started");

  startCronJobs();

  if (!skipBot && !config.BOT_WEBHOOK_URL) {
    // Dev: long polling (не await — блокирует до остановки)
    await bot.api.deleteWebhook().catch(() => undefined);
    bot
      .start({ onStart: (me) => logger.info({ username: me.username }, "bot started (long polling)") })
      .catch((err) => {
        logger.fatal({ err: String(err) }, "bot polling failed — проверьте BOT_TOKEN");
        process.exit(1);
      });
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "graceful shutdown");
    try {
      if (!skipBot && !config.BOT_WEBHOOK_URL) await bot.stop();
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      logger.error({ err: String(err) }, "shutdown error");
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, "startup failed");
  process.exit(1);
});
