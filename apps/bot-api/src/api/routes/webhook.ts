import type { FastifyInstance } from "fastify";
import type { Update } from "grammy/types";
import { bot } from "../../bot/bot.js";
import { config } from "../../config.js";
import { enableRls, prisma } from "../../db.js";
import { logger } from "../../logger.js";

function getWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  const sym = Symbol.for("@vercel/request-context");
  const store = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined>)[sym];
  const waitUntil = store?.get?.()?.waitUntil;
  return typeof waitUntil === "function" ? waitUntil : undefined;
}

/**
 * Имя бота для ссылок-приглашений. Берётся у Telegram один раз на инстанс:
 * зашивать его в код нельзя — оно меняется вместе с BOT_TOKEN.
 */

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// Межинстансовая дедупликация update_id через БД (таблица создаётся сама, миграция не нужна)

let dedupeTableReady = false;
async function isDuplicateUpdate(updateId: number): Promise<boolean> {
  try {
    if (!dedupeTableReady) {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "ProcessedUpdate" ("updateId" BIGINT PRIMARY KEY, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`
      );
      await enableRls("ProcessedUpdate");
      await prisma.$executeRawUnsafe(`DELETE FROM "ProcessedUpdate" WHERE "createdAt" < now() - interval '2 days'`);
      dedupeTableReady = true;
    }
    const inserted = await prisma.$executeRaw`INSERT INTO "ProcessedUpdate" ("updateId") VALUES (${updateId}) ON CONFLICT DO NOTHING`;
    return inserted === 0;
  } catch (err) {
    logger.warn({ err: String(err) }, "update dedupe failed, processing anyway");
    return false;
  }
}

/** Приём апдейтов Telegram и разовая регистрация вебхука. */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // --- Telegram webhook (prod / Vercel) ---
  // Дубли: Telegram ретраит update при медленном/неудачном ответе. Дедупликация — в БД
  // (переживает разные инстансы). Если в рантайме доступен waitUntil — отвечаем сразу
  // и обрабатываем в фоне; иначе обрабатываем синхронно (Telegram дожидается ответа).
  app.post("/api/tg-webhook", async (request, reply) => {
    if (request.headers["x-telegram-bot-api-secret-token"] !== config.webhookSecret) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const update = request.body as Update;

    if (typeof update.update_id === "number" && (await isDuplicateUpdate(update.update_id))) {
      return reply.send({ ok: true, duplicate: true });
    }

    const work = (async () => {
      if (!bot.isInited()) await bot.init();
      await bot.handleUpdate(update);
    })().catch((err) => logger.error({ err: String(err), updateId: update.update_id }, "webhook update failed"));

    const waitUntil = getWaitUntil();
    if (waitUntil) {
      await reply.send({ ok: true });
      waitUntil(work);
    } else {
      // Синхронный режим: лямбда живёт, пока идёт обработка; ретраи отсекает дедупликация
      await work;
      await reply.send({ ok: true });
    }
  });

  // Разовая настройка: регистрация Telegram-webhook на WEBAPP_URL/api/tg-webhook.
  // Вызов: GET /api/setup-webhook?key=<CRON_SECRET>
  app.get("/api/setup-webhook", async (request, reply) => {
    // Ключ берём из сырого URL, а не из распарсенного query: там «+» уже
    // превращён в пробел, и секрет с плюсом никогда не совпадёт. Сравниваем
    // и как есть, и после раскодирования — чтобы принимать оба варианта ввода.
    const rawKey = /[?&]key=([^&#]*)/.exec(request.raw.url ?? "")?.[1] ?? "";
    const candidates = new Set([rawKey, safeDecode(rawKey), (request.query as { key?: string }).key ?? ""]
      .map((k) => k.trim()).filter(Boolean));
    const key = [...candidates].find((k) => k === config.CRON_SECRET) ?? [...candidates][0];
    // Два разных отказа с разным лечением: без CRON_SECRET эндпоинт заперт
    // по замыслу, и никакой ключ не подойдёт — об этом надо сказать прямо,
    // иначе человек будет перебирать ключи, а проблема в переменной окружения.
    if (!config.CRON_SECRET) {
      return reply.code(503).send({
        error: "cron_secret_not_set",
        hint: "Задайте CRON_SECRET в Vercel → Settings → Environment Variables (любая случайная строка), сделайте Redeploy и откройте эту ссылку с ?key=<значение>."
      });
    }
    if (key !== config.CRON_SECRET) {
      return reply.code(401).send({
        error: "unauthorized",
        hint: "Ключ не совпал с CRON_SECRET. Если в секрете есть символы + & # % =, их нужно закодировать для адресной строки: + → %2B и так далее."
      });
    }
    const url = `${config.WEBAPP_URL}/api/tg-webhook`;
    await bot.api.setWebhook(url, { secret_token: config.webhookSecret });
    const info = await bot.api.getWebhookInfo();
    const me = await bot.api.getMe();
    return { ok: true, bot: me.username, webhook: info.url, pendingUpdates: info.pending_update_count };
  });

  // Комбинированный ежедневный тик для планов с лимитом cron-задач (Vercel Hobby):
  // месячные отчёты + деактивация подписок одним вызовом.
}
