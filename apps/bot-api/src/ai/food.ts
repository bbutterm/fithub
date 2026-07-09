import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { buildPhotoHint, JSON_RETRY_PROMPT, TEXT_MEAL_SYSTEM_PROMPT, VISION_SYSTEM_PROMPT } from "../prompts/vision.js";
import { AiUnavailableError, textClient, visionClient, type ChatMessage } from "../lib/ai.js";

const foodItemSchema = z.object({
  dish: z.string().min(1),
  grams: z.coerce.number().nonnegative(),
  kcal: z.coerce.number().nonnegative(),
  protein: z.coerce.number().nonnegative(),
  fat: z.coerce.number().nonnegative(),
  carbs: z.coerce.number().nonnegative(),
  confidence: z.coerce.number().min(0).max(1).default(0.7)
});

const foodResponseSchema = z.object({
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

export class NoFoodError extends Error {
  constructor() {
    super("no_food");
  }
}

const FALLBACK_CONFIDENCE_THRESHOLD = 0.7;

/** Распознавание еды по фото (data URL) — ТОЛЬКО visionClient, при низком confidence повтор fallback-моделью. */
export async function recognizeFoodPhoto(
  imageDataUrl: string,
  userId?: number,
  captionHint?: string
): Promise<FoodRecognition & { model: string }> {
  const userText = captionHint?.trim() ? buildPhotoHint(captionHint.trim()) : "Проанализируй фото еды.";
  const messages: ChatMessage[] = [
    { role: "system", content: VISION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        // detail: high — модель получает фото в полном разрешении, а не сжатую превьюшку
        { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }
      ]
    }
  ];

  const attribution = { userId, purpose: "photo" };
  const primary = await visionClient.chatCompletionJson(messages, foodResponseSchema, JSON_RETRY_PROMPT, { attribution });
  let result = primary.value;
  let usedModel = config.VISION_MODEL;

  const confidence = result.overall_confidence ?? 0;
  if (!result.error && confidence < FALLBACK_CONFIDENCE_THRESHOLD) {
    logger.info({ confidence }, "low confidence, retrying with fallback vision model");
    try {
      const fb = await visionClient.chatCompletionJson(messages, foodResponseSchema, JSON_RETRY_PROMPT, {
        model: config.VISION_MODEL_FALLBACK,
        attribution
      });
      if ((fb.value.overall_confidence ?? 0) > confidence || fb.value.items.length > 0) {
        result = fb.value;
        usedModel = config.VISION_MODEL_FALLBACK;
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "fallback vision model failed, keeping primary result");
    }
  }

  if (result.error === "no_food" || result.items.length === 0) throw new NoFoodError();
  return { ...result, model: usedModel };
}

/**
 * Распознавание еды по текстовому описанию — textClient.
 * Деградация: при 5xx/таймауте text-провайдера разбор временно уходит на visionClient
 * (Qwen умеет текст). Обратной подмены нет: фото ходят только в visionClient.
 */
export async function recognizeFoodText(description: string, userId?: number): Promise<FoodRecognition & { model: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: TEXT_MEAL_SYSTEM_PROMPT },
    { role: "user", content: description }
  ];
  const attribution = { userId, purpose: "text_meal" };
  let value: FoodRecognition;
  let model: string;
  try {
    const res = await textClient.chatCompletionJson(messages, foodResponseSchema, JSON_RETRY_PROMPT, { attribution });
    value = res.value;
    model = config.TEXT_MODEL;
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    logger.warn({ err: String(err) }, "text provider unavailable, degrading text meal parsing to vision client");
    const res = await visionClient.chatCompletionJson(messages, foodResponseSchema, JSON_RETRY_PROMPT, { attribution });
    value = res.value;
    model = config.VISION_MODEL;
  }
  if (value.error === "no_food" || value.items.length === 0) throw new NoFoodError();
  return { ...value, model };
}
