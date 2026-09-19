import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import type { Update } from "grammy/types";
import { z } from "zod";
import { enableRls, prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { validateInitData } from "../auth/initData.js";
import { signPhotoToken, verifyPhotoToken } from "../auth/photoToken.js";
import { deleteAccount, summarizeAccount, upsertUserFromTelegram } from "../services/users.js";
import { calcNorms } from "../services/nutrition.js";
import { addItemsToMeal, deleteItem, deleteMeal, getDay, getMealForUser, updateItemGrams } from "../services/meals.js";
import { calcStreak, getDailyStats } from "../services/stats.js";
import { getActiveSubscription, getPlan } from "../services/subscription.js";
import { NoFoodError, recognizeFoodText } from "../ai/food.js";
import { probeProvidersOnce } from "../lib/ai.js";
import { isAdminTgId, registerAdminRoutes } from "./admin.js";
import { registerBenchRoutes } from "./bench.js";
import { downloadTelegramFile } from "../services/tgfiles.js";
import { refundRecognition, tryConsumeRecognition } from "../services/limits.js";
import { localDateStr } from "../utils/tz.js";
import { DIET_PRESETS, normalizeDiets } from "../diets.js";
import { deleteRecipe, getRecipeForUser, itemsOf, listRecipes, logRecipe, renameRecipe, saveMealAsRecipe } from "../services/recipes.js";
import {
  activeChallengeOf,
  createChallenge,
  dayNumber,
  dayResultsOf,
  finishedChallengesOf,
  historyFacts,
  participantsOf,
  progressOf,
  quitChallenge,
  ruleOf
} from "../services/challenges.js";
import { assessFeasibility, CHALLENGE_TEMPLATES, describeRule, getTemplate, withValue } from "../challenges.js";
import { bot } from "../bot/bot.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { uid: number };
    user: { uid: number };
  }
}

const profileBodySchema = z.object({
  gender: z.enum(["male", "female"]),
  birthYear: z.number().int().min(1920).max(2020),
  heightCm: z.number().int().min(100).max(250),
  weightKg: z.number().min(30).max(400),
  activityLevel: z.enum(["sedentary", "light", "moderate", "high"]),
  goal: z.enum(["lose", "maintain", "gain"]),
  dietType: z.enum(["none", "vegetarian", "vegan", "keto", "halal"]),
  allergies: z.array(z.string().trim().min(1)).max(30).default([]),
  dislikes: z.array(z.string().trim().min(1)).max(30).default([]),
  // Идентификаторы сверяются со справочником, а не принимаются на веру: в промпт
  // уходят правила из кода, и неизвестный идентификатор просто отбрасывается.
  medicalDiets: z.array(z.string()).max(10).default([]).transform(normalizeDiets),
  dietNotes: z.string().trim().max(500).nullable().default(null),
  adviceTone: z.enum(["strict", "friendly", "scientific"]).default("friendly"),
  adviceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  adviceEnabled: z.boolean().default(true),
  reminderEnabled: z.boolean().default(true),
  tz: z.string().max(64).optional(),
  // Ручные цели: если заданы — имеют приоритет над расчётом
  targetKcal: z.number().int().min(800).max(10000).nullable().optional(),
  targetProtein: z.number().int().min(10).max(500).nullable().optional(),
  targetFat: z.number().int().min(10).max(400).nullable().optional(),
  targetCarbs: z.number().int().min(10).max(1200).nullable().optional()
});

function serializeProfile(p: NonNullable<Awaited<ReturnType<typeof prisma.profile.findUnique>>>) {
  return { ...p, updatedAt: p.updatedAt.toISOString() };
}

function serializeMeal(m: {
  id: number;
  userId?: number;
  photoThumbFileId?: string | null;
  eatenAt: Date;
  totalKcal: number;
  totalProtein: number;
  totalFat: number;
  totalCarbs: number;
  aiComment: string | null;
  overallConfidence: number | null;
  source: string;
  photoFileId: string | null;
  items: Array<{ id: number; dish: string; grams: number; kcal: number; protein: number; fat: number; carbs: number; confidence: number }>;
}) {
  return {
    id: m.id,
    eatenAt: m.eatenAt.toISOString(),
    totalKcal: m.totalKcal,
    totalProtein: m.totalProtein,
    totalFat: m.totalFat,
    totalCarbs: m.totalCarbs,
    aiComment: m.aiComment,
    overallConfidence: m.overallConfidence,
    source: m.source,
    hasPhoto: Boolean(m.photoFileId),
    // Подпись выдаётся вместе с приёмом: Mini App не собирает адрес картинки
    // из сессионного токена, а просто подставляет её
    photoToken: m.photoFileId && m.userId !== undefined ? signPhotoToken(m.id, m.userId) : null,
    items: m.items
  };
}

/**
 * waitUntil из request context Vercel (тот же механизм, что в @vercel/functions):
 * позволяет продолжить работу после отправки HTTP-ответа. Доступен не во всех
 * рантаймах — если его нет, webhook обрабатывается синхронно.
 */
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
let botUsernameCache: string | null = null;
async function inviteBase(): Promise<string> {
  if (!botUsernameCache) {
    try {
      botUsernameCache = (await bot.api.getMe()).username;
    } catch {
      return ""; // Telegram недоступен — отдадим только код, ссылку соберёт клиент
    }
  }
  return `https://t.me/${botUsernameCache}?start=ch_`;
}

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

  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });
  app.get("/api/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

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

  // --- Cron-эндпоинты (Vercel Cron / внешний планировщик). Bearer CRON_SECRET, если задан. ---
  const cronAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.CRON_SECRET) return;
    if (request.headers.authorization !== `Bearer ${config.CRON_SECRET}`) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
  app.get("/api/cron/advice", { preHandler: cronAuth }, async () => {
    const { runDailyAdviceTick } = await import("../cron/dailyAdvice.js");
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
    const { ensureWebhook } = await import("../services/webhook.js");
    await ensureWebhook().catch((err) => logger.warn({ err: String(err) }, "webhook self-heal failed"));
    const { runDailyAdviceTick } = await import("../cron/dailyAdvice.js");
    const { runChallengeSummaryTick } = await import("../cron/challengeSummary.js");
    const { runReminderTick } = await import("../cron/reminders.js");
    const { purgeOldQuickChecks } = await import("../services/quickCheck.js");
    // Бюджеты заданы явно: у функции Vercel 60 секунд на всё, а тиков здесь три.
    // Своими значениями по умолчанию они бы вместе не уложились.
    await runDailyAdviceTick(new Date(), 28_000);
    await runChallengeSummaryTick(new Date(), 18_000);
    await runReminderTick(new Date(), 8_000);
    await purgeOldQuickChecks();
    return { ok: true };
  });
  app.get("/api/cron/monthly", { preHandler: cronAuth }, async () => {
    const { runMonthlyReportTick } = await import("../cron/monthlyReport.js");
    await runMonthlyReportTick();
    return { ok: true };
  });
  app.get("/api/cron/subscriptions", { preHandler: cronAuth }, async () => {
    const { runSubscriptionExpiryTick } = await import("../cron/subscriptions.js");
    await runSubscriptionExpiryTick();
    return { ok: true };
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
  app.get("/api/cron/daily", { preHandler: cronAuth }, async () => {
    const { runMonthlyReportTick } = await import("../cron/monthlyReport.js");
    const { runSubscriptionExpiryTick } = await import("../cron/subscriptions.js");
    await runSubscriptionExpiryTick();
    await runMonthlyReportTick();
    return { ok: true };
  });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Только заголовок: единственным потребителем токена в query был фото-прокси,
      // и у него теперь своя короткоживущая подпись
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };

  // --- Auth ---
  app.post("/api/auth/telegram", async (request, reply) => {
    const body = z.object({ initData: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const validated = validateInitData(body.data.initData, config.BOT_TOKEN);
    if (!validated) return reply.code(401).send({ error: "invalid_init_data" });

    const user = await upsertUserFromTelegram(validated.user);
    const token = app.jwt.sign({ uid: user.id });
    // Возвращаем сразу всё, что нужно для старта Mini App — экономим roundtrip к /api/me
    const [profile, plan] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: user.id } }),
      getPlan(user.id)
    ]);
    return {
      token,
      user: { id: user.id, firstName: user.firstName, tz: user.tz },
      hasProfile: Boolean(profile),
      profile: profile ? serializeProfile(profile) : null,
      plan,
      isAdmin: isAdminTgId(user.tgUserId)
    };
  });

  // --- Профиль ---
  app.get("/api/me", { preHandler: authenticate }, async (request) => {
    const uid = request.user.uid;
    const [user, profile, plan, sub] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: uid } }),
      prisma.profile.findUnique({ where: { userId: uid } }),
      getPlan(uid),
      getActiveSubscription(uid)
    ]);
    return {
      user: { id: user.id, firstName: user.firstName, tz: user.tz },
      profile: profile ? serializeProfile(profile) : null,
      plan,
      subscriptionExpiresAt: sub?.expiresAt.toISOString() ?? null,
      isAdmin: isAdminTgId(user.tgUserId)
    };
  });

  // Сводка перед удалением: что именно исчезнет
  app.get("/api/me/summary", { preHandler: authenticate }, async (request, reply) => {
    const summary = await summarizeAccount(request.user.uid);
    if (!summary) return reply.code(404).send({ error: "not_found" });
    return { ...summary, createdAt: summary.createdAt.toISOString() };
  });

  // Удаление аккаунта по требованию пользователя. Подтверждение — на стороне
  // клиента: здесь только необратимое действие.
  app.delete("/api/me", { preHandler: authenticate }, async (request) => {
    await deleteAccount(request.user.uid);
    logger.info({ userId: request.user.uid }, "account deleted by user");
    return { ok: true };
  });

  // --- Мои блюда ---
  const serializeRecipe = (r: Awaited<ReturnType<typeof getRecipeForUser>>) =>
    r && {
      id: r.id,
      name: r.name,
      portionGrams: r.portionGrams,
      kcal: r.kcal,
      protein: r.protein,
      fat: r.fat,
      carbs: r.carbs,
      items: itemsOf(r),
      timesUsed: r.timesUsed,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null
    };

  app.get("/api/recipes", { preHandler: authenticate }, async (request) => {
    const recipes = await listRecipes(request.user.uid, 100);
    return { recipes: recipes.map(serializeRecipe) };
  });

  // Сохранить приём пищи как блюдо (та же кнопка есть в боте под карточкой)
  app.post("/api/recipes", { preHandler: authenticate }, async (request, reply) => {
    const body = z
      .object({ mealId: z.number().int().positive(), name: z.string().trim().min(1).max(60).optional() })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const meal = await getMealForUser(body.data.mealId, request.user.uid);
    if (!meal || meal.items.length === 0) return reply.code(404).send({ error: "not_found" });
    const { recipe, updated } = await saveMealAsRecipe(meal, body.data.name);
    return { recipe: serializeRecipe(recipe), updated };
  });

  // Записать блюдо в дневник. Вызовов ИИ нет, поэтому дневной лимит не расходуется.
  app.post("/api/recipes/:id/log", { preHandler: authenticate }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = z.object({ multiplier: z.number().min(0.1).max(5).default(1) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const recipe = await getRecipeForUser(id, request.user.uid);
    if (!recipe) return reply.code(404).send({ error: "not_found" });
    const meal = await logRecipe(recipe, body.data.multiplier);
    return { meal: serializeMeal(meal) };
  });

  app.patch("/api/recipes/:id", { preHandler: authenticate }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const recipe = await renameRecipe(id, request.user.uid, body.data.name);
    if (!recipe) return reply.code(404).send({ error: "not_found" });
    return { recipe: serializeRecipe(recipe) };
  });

  app.delete("/api/recipes/:id", { preHandler: authenticate }, async (request) => {
    await deleteRecipe(Number((request.params as { id: string }).id), request.user.uid);
    return { ok: true };
  });

  // --- Челленджи ---

  /** Состояние экрана целиком: активный челлендж, шаблоны и история. */
  app.get("/api/challenges", { preHandler: authenticate }, async (request) => {
    const uid = request.user.uid;
    // Три независимых запроса — параллельно: между Vercel и базой сотня
    // миллисекунд на каждый, последовательно это заметно на глаз
    const [user, part, finishedRows] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: uid } }),
      activeChallengeOf(uid),
      finishedChallengesOf(uid)
    ]);

    const active = part
      ? await (async () => {
          const ch = part.challenge;
          const [progress, days, participants] = await Promise.all([
            progressOf(ch.id, uid, ch.days),
            dayResultsOf(ch.id, uid),
            participantsOf(ch.id, uid)
          ]);
          return {
            id: ch.id,
            title: ch.title,
            ruleText: describeRule(ruleOf(ch)),
            startDate: ch.startDate,
            totalDays: ch.days,
            dayNo: dayNumber(ch, localDateStr(user.tz)),
            joinCode: ch.joinCode,
            inviteUrl: `${await inviteBase()}${ch.joinCode}`,
            jokersLeft: part.jokersLeft,
            progress,
            days,
            participants
          };
        })()
      : null;

    const finished = finishedRows.map((p) => ({
      id: p.challenge.id,
      title: p.challenge.title,
      totalDays: p.challenge.days,
      status: p.status
    }));

    return {
      active,
      finished,
      templates: CHALLENGE_TEMPLATES.map((t) => ({
        id: t.id,
        title: t.title,
        hint: t.hint,
        days: t.days,
        ruleText: describeRule(t.rule)
      }))
    };
  });

  /** Выполнимость шаблона по собственной истории — до старта, а не после провала. */
  app.get("/api/challenges/feasibility", { preHandler: authenticate }, async (request, reply) => {
    const q = request.query as { template?: string };
    const template = getTemplate(q.template ?? "");
    if (!template) return reply.code(404).send({ error: "not_found" });
    const uid = request.user.uid;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    const [profile, history] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: uid } }),
      historyFacts(uid, user.tz)
    ]);
    const check = assessFeasibility({
      rule: template.rule,
      days: template.days,
      history,
      profile: profile ? { weightKg: profile.weightKg, gender: profile.gender, targetKcal: profile.targetKcal } : null
    });
    return check;
  });

  app.post("/api/challenges", { preHandler: authenticate }, async (request, reply) => {
    const body = z
      .object({ template: z.string().min(1), value: z.number().int().positive().optional() })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const template = getTemplate(body.data.template);
    if (!template) return reply.code(404).send({ error: "not_found" });
    const uid = request.user.uid;
    // Один активный челлендж: три сразу — это ноль выполненных
    if (await activeChallengeOf(uid)) return reply.code(409).send({ error: "already_active" });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    const rule = body.data.value ? withValue(template.rule, body.data.value) : template.rule;
    const challenge = await createChallenge({
      ownerId: uid,
      title: template.title,
      rule,
      days: template.days,
      tz: user.tz
    });
    return { id: challenge.id, joinCode: challenge.joinCode, startDate: challenge.startDate };
  });

  app.delete("/api/challenges/:id", { preHandler: authenticate }, async (request) => {
    await quitChallenge(Number((request.params as { id: string }).id), request.user.uid);
    return { ok: true };
  });

  // Справочник режимов питания. Отдаётся с сервера, а не дублируется в Mini App:
  // правила и список живут в одном месте — src/diets.ts.
  app.get("/api/diets", async () => ({
    diets: DIET_PRESETS.map(({ id, label, hint }) => ({ id, label, hint }))
  }));

  app.put("/api/profile", { preHandler: authenticate }, async (request, reply) => {
    const parsed = profileBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    const b = parsed.data;
    const uid = request.user.uid;

    const norms = calcNorms({
      gender: b.gender,
      birthYear: b.birthYear,
      heightCm: b.heightCm,
      weightKg: b.weightKg,
      activityLevel: b.activityLevel,
      goal: b.goal
    });
    const targets = {
      targetKcal: b.targetKcal ?? norms.targetKcal,
      targetProtein: b.targetProtein ?? norms.targetProtein,
      targetFat: b.targetFat ?? norms.targetFat,
      targetCarbs: b.targetCarbs ?? norms.targetCarbs
    };
    const data = {
      gender: b.gender,
      birthYear: b.birthYear,
      heightCm: b.heightCm,
      weightKg: b.weightKg,
      activityLevel: b.activityLevel,
      goal: b.goal,
      dietType: b.dietType,
      allergies: b.allergies,
      dislikes: b.dislikes,
      medicalDiets: b.medicalDiets,
      dietNotes: b.dietNotes,
      adviceTone: b.adviceTone,
      adviceTime: b.adviceTime,
      adviceEnabled: b.adviceEnabled,
      reminderEnabled: b.reminderEnabled,
      ...targets
    };
    const profile = await prisma.profile.upsert({
      where: { userId: uid },
      create: { userId: uid, ...data },
      update: data
    });
    if (b.tz) await prisma.user.update({ where: { id: uid }, data: { tz: b.tz } });
    return { profile: serializeProfile(profile), computedNorms: norms };
  });

  // --- День ---
  app.get("/api/day", { preHandler: authenticate }, async (request) => {
    const uid = request.user.uid;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    const q = request.query as { date?: string };
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : localDateStr(user.tz);
    const day = await getDay(uid, date, user.tz);
    return { date, totals: day.totals, meals: day.meals.map(serializeMeal) };
  });

  // --- Приёмы пищи ---
  app.get("/api/meals/:mealId", { preHandler: authenticate }, async (request, reply) => {
    const mealId = Number((request.params as { mealId: string }).mealId);
    const meal = await getMealForUser(mealId, request.user.uid);
    if (!meal) return reply.code(404).send({ error: "not_found" });
    return { meal: serializeMeal(meal) };
  });

  // Изменение времени приёма (не дальше 30 дней назад и не в будущем)
  app.patch("/api/meals/:mealId", { preHandler: authenticate }, async (request, reply) => {
    const params = request.params as { mealId: string };
    const body = z.object({ eatenAt: z.string().datetime() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const eatenAt = new Date(body.data.eatenAt);
    const now = Date.now();
    if (eatenAt.getTime() > now + 10 * 60_000 || eatenAt.getTime() < now - 30 * 24 * 3600 * 1000) {
      return reply.code(400).send({ error: "bad_time" });
    }
    const meal = await getMealForUser(Number(params.mealId), request.user.uid);
    if (!meal) return reply.code(404).send({ error: "not_found" });
    const updated = await prisma.meal.update({ where: { id: meal.id }, data: { eatenAt }, include: { items: true } });
    return { meal: serializeMeal(updated) };
  });

  app.patch("/api/meals/:mealId/items/:itemId", { preHandler: authenticate }, async (request, reply) => {
    const params = request.params as { mealId: string; itemId: string };
    const body = z.object({ grams: z.number().min(1).max(5000) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const meal = await getMealForUser(Number(params.mealId), request.user.uid);
    if (!meal) return reply.code(404).send({ error: "not_found" });
    const updated = await updateItemGrams(meal.id, Number(params.itemId), body.data.grams);
    return { meal: serializeMeal(updated) };
  });

  app.delete("/api/meals/:mealId/items/:itemId", { preHandler: authenticate }, async (request, reply) => {
    const params = request.params as { mealId: string; itemId: string };
    const meal = await getMealForUser(Number(params.mealId), request.user.uid);
    if (!meal) return reply.code(404).send({ error: "not_found" });
    if (meal.items.length <= 1) {
      await deleteMeal(meal.id, request.user.uid);
      return { meal: null };
    }
    const updated = await deleteItem(meal.id, Number(params.itemId));
    return { meal: serializeMeal(updated) };
  });

  app.post("/api/meals/:mealId/items", { preHandler: authenticate }, async (request, reply) => {
    const params = request.params as { mealId: string };
    const body = z.object({ text: z.string().trim().min(3).max(500) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const uid = request.user.uid;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    const meal = await getMealForUser(Number(params.mealId), uid);
    if (!meal) return reply.code(404).send({ error: "not_found" });

    // Занимаем попытку атомарно до вызова модели; если не вышло — возвращаем
    const limit = await tryConsumeRecognition(user);
    if (!limit.allowed) return reply.code(402).send({ error: "limit_reached", limit: limit.limit });
    try {
      const recognition = await recognizeFoodText(body.data.text, uid);
      const updated = await addItemsToMeal(meal.id, recognition);
      return { meal: serializeMeal(updated) };
    } catch (err) {
      await refundRecognition(user);
      if (err instanceof NoFoodError) return reply.code(422).send({ error: "no_food" });
      throw err;
    }
  });

  app.delete("/api/meals/:mealId", { preHandler: authenticate }, async (request) => {
    const params = request.params as { mealId: string };
    await deleteMeal(Number(params.mealId), request.user.uid);
    return { ok: true };
  });

  // --- Фото-прокси (S3 не используется: отдаём файл Telegram через backend) ---
  // ?thumb=1 — маленький размер для превью в ленте (в разы быстрее и дешевле по трафику)
  app.get("/api/photos/:mealId", async (request, reply) => {
    const mealId = Number((request.params as { mealId: string }).mealId);
    const q = request.query as { thumb?: string; t?: string };
    const wantThumb = q.thumb === "1";
    // Только подпись из signPhotoToken: сессионный JWT в адресе картинки уезжал
    // в логи и кэш, давая на 12 часов доступ ко всему аккаунту
    const uid = q.t ? verifyPhotoToken(q.t, mealId) : null;
    if (uid === null) return reply.code(401).send({ error: "unauthorized" });
    const meal = await getMealForUser(mealId, uid);
    if (!meal?.photoFileId) return reply.code(404).send({ error: "not_found" });
    const fileId = wantThumb && meal.photoThumbFileId ? meal.photoThumbFileId : meal.photoFileId;
    try {
      const { buffer, contentType } = await downloadTelegramFile(fileId);
      return reply
        .header("Content-Type", contentType)
        .header("Cache-Control", "private, max-age=86400, immutable")
        .send(buffer);
    } catch {
      return reply.code(502).send({ error: "photo_unavailable" });
    }
  });

  // --- Аналитика ---
  app.get("/api/analytics", { preHandler: authenticate }, async (request, reply) => {
    const uid = request.user.uid;
    const q = request.query as { period?: string };
    const period = q.period === "month" ? "month" : "week";
    const plan = await getPlan(uid);
    if (period === "month" && plan !== "pro") {
      return reply.code(402).send({ error: "pro_required" });
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    const profile = await prisma.profile.findUnique({ where: { userId: uid } });
    const days = period === "month" ? 30 : 7;
    const stats = await getDailyStats(uid, user.tz, days);
    const logged = stats.filter((s) => s.mealsCount > 0);
    const avg = (sel: (s: (typeof stats)[number]) => number) =>
      logged.length ? Math.round(logged.reduce((sum, s) => sum + sel(s), 0) / logged.length) : 0;
    const monthly = await prisma.dailyAdvice.findFirst({
      where: { userId: uid, kind: "monthly" },
      orderBy: { date: "desc" }
    });
    return {
      period,
      days: stats.map((s) => ({ date: s.date, kcal: Math.round(s.kcal), protein: Math.round(s.protein), fat: Math.round(s.fat), carbs: Math.round(s.carbs), mealsCount: s.mealsCount })),
      averages: { kcal: avg((s) => s.kcal), protein: avg((s) => s.protein), fat: avg((s) => s.fat), carbs: avg((s) => s.carbs) },
      targets: {
        kcal: profile?.targetKcal ?? null,
        protein: profile?.targetProtein ?? null,
        fat: profile?.targetFat ?? null,
        carbs: profile?.targetCarbs ?? null
      },
      streak: calcStreak(await getDailyStats(uid, user.tz, 60)),
      monthlyInsight: monthly ? { date: monthly.date, text: monthly.adviceText } : null
    };
  });

  // --- Подписка ---
  app.get("/api/subscription", { preHandler: authenticate }, async (request) => {
    const uid = request.user.uid;
    const [plan, sub, user] = await Promise.all([
      getPlan(uid),
      getActiveSubscription(uid),
      prisma.user.findUniqueOrThrow({ where: { id: uid } })
    ]);
    const today = localDateStr(user.tz);
    const usage = await prisma.usageCounter.findUnique({ where: { userId_date: { userId: uid, date: today } } });
    return {
      plan,
      expiresAt: sub?.expiresAt.toISOString() ?? null,
      prices: { month: config.STARS_PRICE_MONTH, year: config.STARS_PRICE_YEAR },
      // Персональный лимит из админки важнее общего — иначе человек с лимитом 10
      // видит «использовано 4 из 3». Правка уже была в PR #19, её снёс откат dc4e14c.
      freeLimit: user.dailyLimitOverride ?? config.FREE_PHOTOS_PER_DAY,
      usedToday: usage?.photoCount ?? 0
    };
  });

  // приведение типа: инстанс с кастомным pino-логгером совместим по используемым методам
  registerAdminRoutes(app as unknown as Parameters<typeof registerAdminRoutes>[0], authenticate);
  // Стенд моделей: своя проверка по ключу в ссылке, Telegram и JWT не участвуют
  registerBenchRoutes(app as unknown as Parameters<typeof registerBenchRoutes>[0]);

  // Покупки приостановлены: даже старые клиенты не должны получать новые счета.
  app.post("/api/subscription/invoice", { preHandler: authenticate }, async (_request, reply) => {
    return reply.code(503).send({ error: "purchases_unavailable" });
  });

  return app;
}
