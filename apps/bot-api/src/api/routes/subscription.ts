import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { localDateStr } from "../../utils/tz.js";
import { getActiveSubscription, getPlan } from "../../services/subscription.js";
import { authenticate } from "../guards.js";

/** Подписка: состояние и выставление счёта (покупки сейчас выключены). */
export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
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

  // Покупки приостановлены: даже старые клиенты не должны получать новые счета.
  app.post("/api/subscription/invoice", { preHandler: authenticate }, async (_request, reply) => {
    return reply.code(503).send({ error: "purchases_unavailable" });
  });
}
