import type { FastifyInstance } from "fastify";
import { logger } from "../../logger.js";
import { cronAuth } from "../guards.js";

/** Задания по расписанию. Бюджеты времени заданы явно: у функции Vercel 60 секунд на всё. */
export async function cronRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/cron/advice", { preHandler: cronAuth }, async () => {
    const { runDailyAdviceTick } = await import("../../cron/dailyAdvice.js");
    await runDailyAdviceTick();
    return { ok: true };
  });
  // Почасовой тик: и советы, и вечерние сводки челленджей ловят наступивший
  // локальный час пользователя. Одна задача на оба дела — чтобы не держать
  // два набора по 24 записи в vercel.json.
  app.get("/api/cron/hourly", { preHandler: cronAuth }, async () => {
    // Webhook чинится сам: если Telegram смотрит не на нас — переставляем.
    // Бот молчал три недели после снятого webhook, и никто не заметил;
    // крон приходит с верным секретом автоматически, ему ключ вводить не надо.
    const { ensureWebhook } = await import("../../services/webhook.js");
    await ensureWebhook().catch((err: unknown) => logger.warn({ err: String(err) }, "webhook self-heal failed"));
    const { runDailyAdviceTick } = await import("../../cron/dailyAdvice.js");
    const { runChallengeSummaryTick } = await import("../../cron/challengeSummary.js");
    const { runReminderTick } = await import("../../cron/reminders.js");
    const { purgeOldQuickChecks } = await import("../../services/quickCheck.js");
    // Бюджеты заданы явно: у функции Vercel 60 секунд на всё, а тиков здесь три.
    // Своими значениями по умолчанию они бы вместе не уложились.
    await runDailyAdviceTick(new Date(), 28_000);
    await runChallengeSummaryTick(new Date(), 18_000);
    await runReminderTick(new Date(), 8_000);
    await purgeOldQuickChecks();
    return { ok: true };
  });
  app.get("/api/cron/monthly", { preHandler: cronAuth }, async () => {
    const { runMonthlyReportTick } = await import("../../cron/monthlyReport.js");
    await runMonthlyReportTick();
    return { ok: true };
  });
  app.get("/api/cron/subscriptions", { preHandler: cronAuth }, async () => {
    const { runSubscriptionExpiryTick } = await import("../../cron/subscriptions.js");
    await runSubscriptionExpiryTick();
    return { ok: true };
  });
  app.get("/api/cron/daily", { preHandler: cronAuth }, async () => {
    const { runMonthlyReportTick } = await import("../../cron/monthlyReport.js");
    const { runSubscriptionExpiryTick } = await import("../../cron/subscriptions.js");
    await runSubscriptionExpiryTick();
    await runMonthlyReportTick();
    return { ok: true };
  });
}
