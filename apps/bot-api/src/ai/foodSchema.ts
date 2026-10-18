import { z } from "zod";

/**
 * Схема ответа модели о еде.
 *
 * Вынесена из ai/food.ts отдельно и намеренно ничего не импортирует, кроме zod:
 * тот же разбор нужен стенду сравнения моделей и прогону eval, а тянуть ради
 * него конфигурацию с обязательными ключами провайдеров и клиента к базе
 * незачем. Правила разбора должны быть одни и те же, иначе eval померяет не то,
 * что делает бот.
 */
export const foodItemSchema = z.object({
  dish: z.string().min(1),
  grams: z.coerce.number().nonnegative(),
  kcal: z.coerce.number().nonnegative(),
  protein: z.coerce.number().nonnegative(),
  fat: z.coerce.number().nonnegative(),
  carbs: z.coerce.number().nonnegative(),
  confidence: z.coerce.number().min(0).max(1).default(0.7)
});

export const foodResponseSchema = z.object({
  observed: z.string().optional(), // «рассуждение» модели: что видно на фото — улучшает точность
  items: z.array(foodItemSchema).default([]),
  total: z
    .object({
      kcal: z.coerce.number().optional(),
      protein: z.coerce.number().optional(),
      fat: z.coerce.number().optional(),
      carbs: z.coerce.number().optional()
    })
    .optional(),
  comment: z.string().optional(),
  overall_confidence: z.coerce.number().min(0).max(1).optional(),
  error: z.string().optional()
});

export type FoodRecognition = z.infer<typeof foodResponseSchema>;
