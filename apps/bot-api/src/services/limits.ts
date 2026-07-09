import type { User } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { localDateStr } from "../utils/tz.js";
import { getPlan } from "./subscription.js";

export interface LimitCheck {
  allowed: boolean;
  used: number;
  limit: number | null; // null = безлимит (Pro)
}

/** Проверка дневного лимита распознаваний free-тарифа (фото и текст считаются одинаково). */
export async function checkRecognitionLimit(user: User): Promise<LimitCheck> {
  const plan = await getPlan(user.id);
  if (plan === "pro") return { allowed: true, used: 0, limit: null };
  const date = localDateStr(user.tz);
  const counter = await prisma.usageCounter.findUnique({
    where: { userId_date: { userId: user.id, date } }
  });
  const used = counter?.photoCount ?? 0;
  // Персональный лимит из админки имеет приоритет над общим free-лимитом
  const limit = user.dailyLimitOverride ?? config.FREE_PHOTOS_PER_DAY;
  return { allowed: used < limit, used, limit };
}

export async function incrementRecognitionCount(user: User): Promise<void> {
  const date = localDateStr(user.tz);
  await prisma.usageCounter.upsert({
    where: { userId_date: { userId: user.id, date } },
    create: { userId: user.id, date, photoCount: 1 },
    update: { photoCount: { increment: 1 } }
  });
}
