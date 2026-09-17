import { z } from "zod";
import { logger } from "../logger.js";
import { textClient, type ChatMessage } from "../lib/ai.js";
import { buildDietCheckRequest, DIET_CHECK_SYSTEM_PROMPT } from "../prompts/diet.js";
import { JSON_RETRY_PROMPT } from "../prompts/vision.js";
import { buildDietContext } from "../diets.js";

export const dietVerdictSchema = z.object({
  verdict: z.enum(["ok", "caution", "avoid"]),
  note: z.string().trim().max(400).default("")
});
export type DietVerdict = z.infer<typeof dietVerdictSchema>;

/** Профиль в том виде, в каком его читает бот: только поля, влияющие на проверку. */
export type DietProfileFields = {
  medicalDiets: string[];
  dietNotes: string | null;
  allergies: string[];
};

/**
 * Сверяет приём пищи с режимом питания пользователя.
 *
 * Возвращает null в трёх случаях, и все три — штатные:
 *   1) режим не задан — вызова модели не происходит, денег не тратим;
 *   2) в приёме нет блюд;
 *   3) провайдер не ответил — проверка необязательная, карточка с КБЖУ важнее.
 */
export async function checkMealAgainstDiet(params: {
  dishes: string[];
  profile: DietProfileFields | null;
  userId?: number;
}): Promise<DietVerdict | null> {
  if (!params.profile || params.dishes.length === 0) return null;

  const ctx = buildDietContext({
    diets: params.profile.medicalDiets,
    notes: params.profile.dietNotes,
    allergies: params.profile.allergies
  });
  if (!ctx) return null;

  const messages: ChatMessage[] = [
    { role: "system", content: DIET_CHECK_SYSTEM_PROMPT },
    { role: "user", content: buildDietCheckRequest({ dishes: params.dishes, rulesText: ctx.rulesText }) }
  ];

  try {
    const res = await textClient.chatCompletionJson(messages, dietVerdictSchema, JSON_RETRY_PROMPT, {
      attribution: { userId: params.userId, purpose: "diet_check" }
    });
    if (!res.value.note) return null;
    return res.value;
  } catch (err) {
    // Осознанно глушим: не получить отметку о диете неприятно, но потерять из-за
    // этого всю карточку с распознанной едой — хуже.
    logger.warn({ err: String(err), userId: params.userId }, "diet check failed, card goes without it");
    return null;
  }
}
