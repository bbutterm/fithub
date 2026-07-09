import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { webhookCallback } from "grammy";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { validateInitData } from "../auth/initData.js";
import { upsertUserFromTelegram } from "../services/users.js";
import { calcNorms } from "../services/nutrition.js";
import { addItemsToMeal, deleteItem, deleteMeal, getDay, getMealForUser, updateItemGrams } from "../services/meals.js";
import { calcStreak, getDailyStats } from "../services/stats.js";
import { getActiveSubscription, getPlan } from "../services/subscription.js";
import { NoFoodError, recognizeFoodText } from "../ai/food.js";
import { probeProvidersOnce } from "../lib/ai.js";
import { downloadTelegramFile } from "../services/tgfiles.js";
import { checkRecognitionLimit, incrementRecognitionCount } from "../services/limits.js";
import { localDateStr } from "../utils/tz.js";
import { PLAN_PAYLOADS } from "../bot/payments.js";
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
  adviceTone: z.enum(["strict", "friendly", "scientific"]).default("friendly"),
  adviceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  adviceEnabled: z.boolean().default(true),
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
    items: m.items
  };
}

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });
  // Probe ИИ-провайдеров: не блокирует старт, но подсказывает в логе про устаревшие модели
  probeProvidersOnce();

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

  // --- Telegram webhook (prod / Vercel). Подлинность проверяется секретным токеном
  // до передачи в grammY, чтобы посторонние запросы не доходили до bot.init(). ---
  app.post(
    "/api/tg-webhook",
    {
      preHandler: async (request, reply) => {
        if (request.headers["x-telegram-bot-api-secret-token"] !== config.webhookSecret) {
          await reply.code(401).send({ error: "unauthorized" });
        }
      }
    },
    webhookCallback(bot, "fastify", { secretToken: config.webhookSecret })
  );

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
      if (!request.headers.authorization) {
        // для <img>: токен можно передать query-параметром
        const token = (request.query as { token?: string }).token;
        if (token) {
          request.user = app.jwt.verify<{ uid: number }>(token);
          return;
        }
      }
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
    const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
    return {
      token,
      user: { id: user.id, firstName: user.firstName, tz: user.tz },
      hasProfile: Boolean(profile)
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
      subscriptionExpiresAt: sub?.expiresAt.toISOString() ?? null
    };
  });

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
      adviceTone: b.adviceTone,
      adviceTime: b.adviceTime,
      adviceEnabled: b.adviceEnabled,
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

    const limit = await checkRecognitionLimit(user);
    if (!limit.allowed) return reply.code(402).send({ error: "limit_reached", limit: limit.limit });
    try {
      const recognition = await recognizeFoodText(body.data.text);
      await incrementRecognitionCount(user);
      const updated = await addItemsToMeal(meal.id, recognition);
      return { meal: serializeMeal(updated) };
    } catch (err) {
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
  app.get("/api/photos/:mealId", { preHandler: authenticate }, async (request, reply) => {
    const mealId = Number((request.params as { mealId: string }).mealId);
    const meal = await getMealForUser(mealId, request.user.uid);
    if (!meal?.photoFileId) return reply.code(404).send({ error: "not_found" });
    try {
      const { buffer, contentType } = await downloadTelegramFile(meal.photoFileId);
      return reply.header("Content-Type", contentType).header("Cache-Control", "private, max-age=1800").send(buffer);
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
      freeLimit: config.FREE_PHOTOS_PER_DAY,
      usedToday: usage?.photoCount ?? 0
    };
  });

  app.post("/api/subscription/invoice", { preHandler: authenticate }, async (request, reply) => {
    const body = z.object({ plan: z.enum(["month", "year"]) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const p = PLAN_PAYLOADS[body.data.plan];
    const link = await bot.api.createInvoiceLink(
      p.title,
      "Безлимит распознаваний, ежедневные советы, месячная аналитика и отчёты.",
      p.payload,
      "", // provider_token пуст для Telegram Stars
      "XTR",
      [{ label: p.title, amount: p.stars() }]
    );
    return { link };
  });

  return app;
}
