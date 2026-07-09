import type { Plan } from "@prisma/client";
import { prisma } from "../db.js";

export async function getActiveSubscription(userId: number) {
  return prisma.subscription.findFirst({
    where: { userId, status: "active", expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: "desc" }
  });
}

export async function getPlan(userId: number): Promise<Plan> {
  const sub = await getActiveSubscription(userId);
  return sub ? sub.plan : "free";
}

/** Создание/продление Pro: продлеваем от текущего expiresAt, если подписка ещё активна. */
export async function extendPro(userId: number, days: number, starsPaymentId?: string) {
  const current = await getActiveSubscription(userId);
  const base = current && current.expiresAt > new Date() ? current.expiresAt : new Date();
  const expiresAt = new Date(base.getTime() + days * 24 * 3600 * 1000);
  if (current) {
    return prisma.subscription.update({
      where: { id: current.id },
      data: { expiresAt, starsPaymentId: starsPaymentId ?? current.starsPaymentId }
    });
  }
  return prisma.subscription.create({
    data: { userId, plan: "pro", status: "active", expiresAt, starsPaymentId }
  });
}

/** Деактивация истёкших подписок; возвращает пользователей для уведомления. */
export async function expireSubscriptions() {
  const expired = await prisma.subscription.findMany({
    where: { status: "active", expiresAt: { lte: new Date() } },
    include: { user: true }
  });
  if (expired.length === 0) return [];
  await prisma.subscription.updateMany({
    where: { id: { in: expired.map((s) => s.id) } },
    data: { status: "expired" }
  });
  return expired;
}
