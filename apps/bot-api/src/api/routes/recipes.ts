import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMealForUser } from "../../services/meals.js";
import { deleteRecipe, getRecipeForUser, listRecipes, logRecipe, renameRecipe, saveMealAsRecipe } from "../../services/recipes.js";
import { authenticate } from "../guards.js";
import { serializeMeal, serializeRecipe } from "../serializers.js";

/** «Мои блюда»: сохранение приёма как блюда и запись его обратно в дневник. */
export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  // --- Мои блюда ---
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
}
