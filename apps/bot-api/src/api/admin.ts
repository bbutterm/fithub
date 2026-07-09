import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extendPro, getActiveSubscription } from "../services/subscription.js";

export function isAdminTgId(tgUserId: bigint): boolean {
  return config.adminTgIds.has(String(tgUserId));
}

/** Админ-роуты: доступ только пользователям из ADMIN_TG_IDS (по проверенному tgUserId). */
export function registerAdminRoutes(app: FastifyInstance, authenticate: (r: FastifyRequest, rep: FastifyReply) => Promise<void>) {
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    if (reply.sent) return;
    const user = await prisma.user.findUnique({ where: { id: request.user.uid } });
    if (!user || !isAdminTgId(user.tgUserId)) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };

  // Сводка: пользователи, расходы на ИИ (всего / 30 дней), разбивка по клиентам
  app.get("/api/admin/overview", { preHandler: requireAdmin }, async () => {
    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [usersCount, activePro, mealsCount, spendAll, spend30d, byClient] = await Promise.all([
      prisma.user.count(),
      prisma.subscription.count({ where: { status: "active", plan: "pro", expiresAt: { gt: new Date() } } }),
      prisma.meal.count(),
      prisma.aiUsage.aggregate({ _sum: { costUsd: true, promptTokens: true, completionTokens: true } }),
      prisma.aiUsage.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: since30d } } }),
      prisma.aiUsage.groupBy({
        by: ["client", "model"],
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
        _count: { _all: true }
      })
    ]);
    return {
      usdRubRate: config.USD_RUB_RATE,
      usersCount,
      activePro,
      mealsCount,
      spend: {
        totalUsd: spendAll._sum.costUsd ?? 0,
        last30dUsd: spend30d._sum.costUsd ?? 0,
        promptTokens: spendAll._sum.promptTokens ?? 0,
        completionTokens: spendAll._sum.completionTokens ?? 0
      },
      byModel: byClient.map((c) => ({
        client: c.client,
        model: c.model,
        calls: c._count._all,
        promptTokens: c._sum.promptTokens ?? 0,
        completionTokens: c._sum.completionTokens ?? 0,
        costUsd: c._sum.costUsd ?? 0
      }))
    };
  });

  // Список пользователей с агрегатами расходов и активности
  app.get("/api/admin/users", { preHandler: requireAdmin }, async (request) => {
    const q = (request.query as { query?: string }).query?.trim().toLowerCase();
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        profile: { select: { goal: true } },
        subscriptions: { where: { status: "active", expiresAt: { gt: new Date() } }, take: 1, orderBy: { expiresAt: "desc" } },
        _count: { select: { meals: true } }
      }
    });
    const spendByUser = await prisma.aiUsage.groupBy({
      by: ["userId"],
      _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      _count: { _all: true }
    });
    const spendMap = new Map(spendByUser.map((s) => [s.userId, s]));
    const list = users
      .map((u) => {
        const spend = spendMap.get(u.id);
        const sub = u.subscriptions[0];
        return {
          id: u.id,
          tgUserId: String(u.tgUserId),
          firstName: u.firstName,
          username: u.username,
          createdAt: u.createdAt.toISOString(),
          plan: sub ? "pro" : "free",
          proExpiresAt: sub?.expiresAt.toISOString() ?? null,
          dailyLimitOverride: u.dailyLimitOverride,
          mealsCount: u._count.meals,
          aiCalls: spend?._count._all ?? 0,
          tokens: (spend?._sum.promptTokens ?? 0) + (spend?._sum.completionTokens ?? 0),
          costUsd: spend?._sum.costUsd ?? 0,
          isAdmin: isAdminTgId(u.tgUserId)
        };
      })
      .filter(
        (u) =>
          !q ||
          u.username?.toLowerCase().includes(q) ||
          u.firstName?.toLowerCase().includes(q) ||
          u.tgUserId.includes(q)
      );
    return { users: list, usdRubRate: config.USD_RUB_RATE };
  });

  // Выдать/продлить Pro на N дней (отрицательные значения не принимаем)
  app.post("/api/admin/users/:id/pro", { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = z.object({ days: z.number().int().min(1).max(3650) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const sub = await extendPro(id, body.data.days, "admin_grant");
    logger.info({ adminUid: request.user.uid, userId: id, days: body.data.days }, "admin granted pro");
    return { ok: true, expiresAt: sub.expiresAt.toISOString() };
  });

  // Отключить Pro (перевести активную подписку в canceled)
  app.delete("/api/admin/users/:id/pro", { preHandler: requireAdmin }, async (request) => {
    const id = Number((request.params as { id: string }).id);
    const sub = await getActiveSubscription(id);
    if (sub) await prisma.subscription.update({ where: { id: sub.id }, data: { status: "canceled", expiresAt: new Date() } });
    logger.info({ adminUid: request.user.uid, userId: id }, "admin revoked pro");
    return { ok: true };
  });

  // Персональный дневной лимит распознаваний для free (null — вернуть общий)
  app.post("/api/admin/users/:id/limit", { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = z.object({ limit: z.number().int().min(0).max(1000).nullable() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    await prisma.user.update({ where: { id }, data: { dailyLimitOverride: body.data.limit } });
    logger.info({ adminUid: request.user.uid, userId: id, limit: body.data.limit }, "admin set limit");
    return { ok: true };
  });

  // Детализация расходов пользователя (последние 50 вызовов)
  app.get("/api/admin/users/:id/usage", { preHandler: requireAdmin }, async (request) => {
    const id = Number((request.params as { id: string }).id);
    const rows = await prisma.aiUsage.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return {
      usdRubRate: config.USD_RUB_RATE,
      usage: rows.map((r) => ({
        createdAt: r.createdAt.toISOString(),
        client: r.client,
        model: r.model,
        purpose: r.purpose,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        costUsd: r.costUsd
      }))
    };
  });
}
