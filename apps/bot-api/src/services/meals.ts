import type { MealSource, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { FoodRecognition } from "../ai/food.js";
import { scaleItem, sumItems } from "./nutrition.js";
import { zonedDayRangeUtc } from "../utils/tz.js";

export async function createMealFromRecognition(params: {
  userId: number;
  recognition: FoodRecognition;
  source: MealSource;
  photoFileId?: string;
  photoThumbFileId?: string;
  eatenAt?: Date;
}) {
  const items = params.recognition.items.map((i) => ({
    dish: i.dish,
    grams: i.grams,
    kcal: i.kcal,
    protein: i.protein,
    fat: i.fat,
    carbs: i.carbs,
    confidence: i.confidence
  }));
  const totals = sumItems(items);
  return prisma.meal.create({
    data: {
      userId: params.userId,
      source: params.source,
      photoFileId: params.photoFileId,
      photoThumbFileId: params.photoThumbFileId,
      eatenAt: params.eatenAt ?? new Date(),
      aiComment: params.recognition.comment ?? null,
      overallConfidence: params.recognition.overall_confidence ?? null,
      ...totals,
      items: { create: items }
    },
    include: { items: true }
  });
}

export async function getMealForUser(mealId: number, userId: number) {
  return prisma.meal.findFirst({ where: { id: mealId, userId }, include: { items: true } });
}

async function recalcMealTotals(mealId: number, tx: Prisma.TransactionClient = prisma) {
  const items = await tx.mealItem.findMany({ where: { mealId } });
  const totals = sumItems(items);
  return tx.meal.update({ where: { id: mealId }, data: totals, include: { items: true } });
}

/** Изменение граммов позиции — КБЖУ пересчитываются пропорционально. */
export async function updateItemGrams(mealId: number, itemId: number, newGrams: number) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.mealItem.findFirstOrThrow({ where: { id: itemId, mealId } });
    await tx.mealItem.update({ where: { id: itemId }, data: scaleItem(item, newGrams) });
    return recalcMealTotals(mealId, tx);
  });
}

export async function deleteItem(mealId: number, itemId: number) {
  return prisma.$transaction(async (tx) => {
    await tx.mealItem.delete({ where: { id: itemId } });
    return recalcMealTotals(mealId, tx);
  });
}

/** Полная замена позиций приёма (уточнение ответом на карточку). */
export async function replaceMealItems(mealId: number, recognition: FoodRecognition) {
  return prisma.$transaction(async (tx) => {
    await tx.mealItem.deleteMany({ where: { mealId } });
    await tx.mealItem.createMany({
      data: recognition.items.map((i) => ({
        mealId,
        dish: i.dish,
        grams: i.grams,
        kcal: i.kcal,
        protein: i.protein,
        fat: i.fat,
        carbs: i.carbs,
        confidence: i.confidence
      }))
    });
    await tx.meal.update({
      where: { id: mealId },
      data: {
        aiComment: recognition.comment ?? null,
        overallConfidence: recognition.overall_confidence ?? null
      }
    });
    return recalcMealTotals(mealId, tx);
  });
}

export async function addItemsToMeal(mealId: number, recognition: FoodRecognition) {
  return prisma.$transaction(async (tx) => {
    await tx.mealItem.createMany({
      data: recognition.items.map((i) => ({
        mealId,
        dish: i.dish,
        grams: i.grams,
        kcal: i.kcal,
        protein: i.protein,
        fat: i.fat,
        carbs: i.carbs,
        confidence: i.confidence
      }))
    });
    return recalcMealTotals(mealId, tx);
  });
}

export async function deleteMeal(mealId: number, userId: number) {
  await prisma.meal.deleteMany({ where: { id: mealId, userId } });
}

/** Приёмы пищи и суммарные КБЖУ за локальные сутки пользователя. */
export async function getDay(userId: number, dateStr: string, tz: string) {
  const { start, end } = zonedDayRangeUtc(dateStr, tz);
  const meals = await prisma.meal.findMany({
    where: { userId, eatenAt: { gte: start, lt: end } },
    include: { items: true },
    orderBy: { eatenAt: "asc" }
  });
  const totals = sumItems(
    meals.map((m) => ({ kcal: m.totalKcal, protein: m.totalProtein, fat: m.totalFat, carbs: m.totalCarbs }))
  );
  return { meals, totals };
}
