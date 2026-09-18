import type { Meal, MealItem, Recipe } from "@prisma/client";
import { prisma } from "../db.js";
import { sumItems } from "./nutrition.js";

/** Позиция блюда в том же виде, в каком её хранит MealItem. */
export interface RecipeItem {
  dish: string;
  grams: number;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Имя сохранённого блюда по его составу.
 *
 * Человеку не хочется придумывать название на ходу, поэтому предлагаем своё:
 * две самые калорийные позиции через запятую. Запятая, а не «с»: склонять
 * названия мы не умеем, и склейка давала «куриная грудка с рис отварной».
 * Перечисление грамматически нейтрально при любых словах.
 */
export function suggestRecipeName(items: RecipeItem[]): string {
  const parts = [...items]
    .sort((a, b) => b.kcal - a.kcal)
    .map((i) => i.dish?.trim())
    .filter((d): d is string => Boolean(d))
    .slice(0, 2);
  if (parts.length === 0) return "Блюдо";
  const name = parts.join(", ");
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  return capitalized.length > 60 ? `${capitalized.slice(0, 57)}…` : capitalized;
}

export function itemsOf(recipe: Recipe): RecipeItem[] {
  return Array.isArray(recipe.items) ? (recipe.items as unknown as RecipeItem[]) : [];
}

/**
 * Сохранить приём пищи как блюдо.
 *
 * Имя уникально в пределах пользователя: повторное сохранение того же блюда
 * обновляет состав, а не плодит «Овсянка (2)». Возвращает запись и признак
 * того, что это обновление — чтобы бот сказал «обновил», а не «сохранил».
 */
export async function saveMealAsRecipe(
  meal: Meal & { items: MealItem[] },
  name?: string
): Promise<{ recipe: Recipe; updated: boolean }> {
  const items: RecipeItem[] = meal.items.map((i) => ({
    dish: i.dish,
    grams: r1(i.grams),
    kcal: r1(i.kcal),
    protein: r1(i.protein),
    fat: r1(i.fat),
    carbs: r1(i.carbs)
  }));
  const totals = sumItems(items);
  const portionGrams = r1(items.reduce((s, i) => s + i.grams, 0));
  const finalName = (name?.trim() || suggestRecipeName(items)).slice(0, 60);

  const existing = await prisma.recipe.findUnique({
    where: { userId_name: { userId: meal.userId, name: finalName } }
  });
  const data = {
    portionGrams,
    kcal: totals.totalKcal,
    protein: totals.totalProtein,
    fat: totals.totalFat,
    carbs: totals.totalCarbs,
    items: items as unknown as object,
    sourceMealId: meal.id
  };
  const recipe = existing
    ? await prisma.recipe.update({ where: { id: existing.id }, data })
    : await prisma.recipe.create({ data: { userId: meal.userId, name: finalName, ...data } });
  return { recipe, updated: Boolean(existing) };
}

/** Часто используемые сверху: список в боте помещается в несколько кнопок. */
export async function listRecipes(userId: number, take = 20): Promise<Recipe[]> {
  return prisma.recipe.findMany({
    where: { userId },
    orderBy: [{ timesUsed: "desc" }, { lastUsedAt: "desc" }, { id: "desc" }],
    take
  });
}

export async function getRecipeForUser(recipeId: number, userId: number): Promise<Recipe | null> {
  return prisma.recipe.findFirst({ where: { id: recipeId, userId } });
}

/**
 * Записать сохранённое блюдо в дневник.
 *
 * Множитель — это «полпорции», «полторы»: без него блюда бесполезны, люди едят
 * разные порции и вернутся к фотографированию. Вызовов ИИ здесь нет вообще —
 * ради этого фича и затевалась.
 */
export async function logRecipe(recipe: Recipe, multiplier: number, eatenAt?: Date) {
  const k = multiplier;
  const items = itemsOf(recipe).map((i) => ({
    dish: i.dish,
    grams: r1(i.grams * k),
    kcal: r1(i.kcal * k),
    protein: r1(i.protein * k),
    fat: r1(i.fat * k),
    carbs: r1(i.carbs * k),
    confidence: 1 // состав задал сам пользователь — гадать не о чем
  }));
  const totals = sumItems(items);

  const [meal] = await prisma.$transaction([
    prisma.meal.create({
      data: {
        userId: recipe.userId,
        source: "manual",
        eatenAt: eatenAt ?? new Date(),
        ...totals,
        items: { create: items }
      },
      include: { items: true }
    }),
    prisma.recipe.update({
      where: { id: recipe.id },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() }
    })
  ]);
  return meal;
}

export async function renameRecipe(recipeId: number, userId: number, name: string): Promise<Recipe | null> {
  const recipe = await getRecipeForUser(recipeId, userId);
  if (!recipe) return null;
  return prisma.recipe.update({ where: { id: recipe.id }, data: { name: name.trim().slice(0, 60) } });
}

export async function deleteRecipe(recipeId: number, userId: number): Promise<void> {
  await prisma.recipe.deleteMany({ where: { id: recipeId, userId } });
}
