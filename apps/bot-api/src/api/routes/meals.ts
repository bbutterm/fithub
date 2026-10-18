import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { NoFoodError, recognizeFoodText } from "../../ai/food.js";
import { verifyPhotoToken } from "../../auth/photoToken.js";
import { refundRecognition, tryConsumeRecognition } from "../../services/limits.js";
import { addItemsToMeal, deleteItem, deleteMeal, getDay, getMealForUser, updateItemGrams } from "../../services/meals.js";
import { downloadTelegramFile } from "../../services/tgfiles.js";
import { localDateStr } from "../../utils/tz.js";
import { authenticate } from "../guards.js";
import { serializeMeal } from "../serializers.js";

/** Дневник: день, приёмы пищи, позиции и выдача фото. */
export async function mealRoutes(app: FastifyInstance): Promise<void> {
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
}
