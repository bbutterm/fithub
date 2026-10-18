import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { logger } from "../../logger.js";
import { DIET_PRESETS, normalizeDiets } from "../../diets.js";
import { calcNorms } from "../../services/nutrition.js";
import { getActiveSubscription, getPlan } from "../../services/subscription.js";
import { deleteAccount, summarizeAccount } from "../../services/users.js";
import { isValidTz } from "../../utils/tz.js";
import { isAdminTgId } from "../admin.js";
import { authenticate } from "../guards.js";
import { serializeProfile } from "../serializers.js";

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
  // Пояс проверяем, а не просто ограничиваем длину: с несуществующим значением
  // падает любое форматирование даты, и дневник отвечает ошибкой навсегда.
  tz: z.string().max(64).refine(isValidTz, "unknown_timezone").optional(),
  // Ручные цели: если заданы — имеют приоритет над расчётом
  targetKcal: z.number().int().min(800).max(10000).nullable().optional(),
  targetProtein: z.number().int().min(10).max(500).nullable().optional(),
  targetFat: z.number().int().min(10).max(400).nullable().optional(),
  targetCarbs: z.number().int().min(10).max(1200).nullable().optional()
});

/** Профиль, нормы, справочник режимов питания и удаление аккаунта. */
export async function profileRoutes(app: FastifyInstance): Promise<void> {
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
}
