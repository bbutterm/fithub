import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { probeProvidersOnce } from "../lib/ai.js";
import { registerAdminRoutes } from "./admin.js";
import { authenticate } from "./guards.js";
import { registerBenchRoutes } from "./bench.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { authRoutes } from "./routes/auth.js";
import { challengeRoutes } from "./routes/challenges.js";
import { cronRoutes } from "./routes/cron.js";
import { healthRoutes } from "./routes/health.js";
import { mealRoutes } from "./routes/meals.js";
import { profileRoutes } from "./routes/profile.js";
import { recipeRoutes } from "./routes/recipes.js";
import { subscriptionRoutes } from "./routes/subscription.js";
import { webhookRoutes } from "./routes/webhook.js";
import "./types.js";

/**
 * Сборка HTTP-сервера.
 *
 * Здесь только общая настройка и подключение групп маршрутов; сами маршруты
 * живут в routes/ по областям. Раньше этот файл был на восемьсот строк, и
 * найти в нём нужный обработчик получалось только поиском по строке.
 */
export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });
  // Probe ИИ-провайдеров подсказывает в логе про устаревшие модели. На Vercel
  // каждый холодный старт — это два платных вызова и две строки мусора в учёте
  // расходов (по ним мы три недели думали, что бот жив). Там пинг не нужен:
  // ошибка модели и так видна по первому реальному запросу.
  if (!process.env.VERCEL) probeProvidersOnce();

  // Отражаем любой источник — и это осознанно, а не «руки не дошли».
  //
  // Попытка сузить список до одного WEBAPP_URL положила Mini App: стоит адресу
  // страницы разойтись со значением переменной хоть на косую черту в конце или
  // на другой алиас домена Vercel — заголовок Access-Control-Allow-Origin не
  // выставляется, браузер не даёт прочитать ответ, и авторизация падает целиком.
  // Проверено локально: запрос с чужим Origin возвращает 200 без заголовка,
  // а preflight — 204 без разрешения.
  //
  // Цена открытого CORS здесь невелика: авторизация идёт по заголовку Bearer,
  // куки не используются, поэтому чужая страница всё равно не получит токен.
  // Если сужать — то по списку доменов, собранному из фактических адресов
  // деплоя, и обязательно с проверкой на живом Mini App.
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: "12h" } });

  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(cronRoutes);
  await app.register(authRoutes);
  await app.register(profileRoutes);
  await app.register(recipeRoutes);
  await app.register(challengeRoutes);
  await app.register(mealRoutes);
  await app.register(analyticsRoutes);
  await app.register(subscriptionRoutes);
  // Приведение типа: инстанс с кастомным pino-логгером совместим по используемым методам
  registerAdminRoutes(app as unknown as Parameters<typeof registerAdminRoutes>[0], authenticate);
  // Стенд моделей: своя проверка по ключу в ссылке, Telegram и JWT не участвуют
  registerBenchRoutes(app as unknown as Parameters<typeof registerBenchRoutes>[0]);

  return app;
}
