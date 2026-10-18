import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { calcStreak, getDailyStats } from "../../services/stats.js";
import { getPlan } from "../../services/subscription.js";
import { authenticate } from "../guards.js";

/** Аналитика: неделя всем, месяц — только Pro. */
export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
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
}
