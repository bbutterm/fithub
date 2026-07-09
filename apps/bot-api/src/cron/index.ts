import cron from "node-cron";
import { logger } from "../logger.js";
import { runDailyAdviceTick } from "./dailyAdvice.js";
import { runMonthlyReportTick } from "./monthlyReport.js";
import { runSubscriptionExpiryTick } from "./subscriptions.js";

export function startCronJobs(): void {
  // Ежедневные советы: каждые 15 минут ловим наступившее adviceTime в таймзоне пользователя
  cron.schedule("*/15 * * * *", () => {
    runDailyAdviceTick().catch((err) => logger.error({ err: String(err) }, "advice tick crashed"));
  });

  // Месячный отчёт (Pro): ежечасно проверяем «1-е число, после 10:00 локального времени»
  cron.schedule("0 * * * *", () => {
    runMonthlyReportTick().catch((err) => logger.error({ err: String(err) }, "monthly tick crashed"));
  });

  // Истечение подписок: ежедневно в 00:15 UTC
  cron.schedule("15 0 * * *", () => {
    runSubscriptionExpiryTick().catch((err) => logger.error({ err: String(err) }, "expiry tick crashed"));
  });

  logger.info("cron jobs scheduled");
}
