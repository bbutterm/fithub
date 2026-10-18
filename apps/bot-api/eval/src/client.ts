import { readFileSync } from "node:fs";
import path from "node:path";
import { foodResponseSchema } from "../../src/ai/foodSchema.js";
import { JSON_RETRY_PROMPT, VISION_SYSTEM_PROMPT } from "../../src/prompts/vision.js";

/**
 * Вызов vision-модели в условиях прогона.
 *
 * Намеренно не используется рабочий клиент бота: здесь нужна фиксированная
 * температура, отсутствие записи расходов в базу и раздельный учёт сетевых
 * повторов. Промпт и схема разбора при этом берутся боевые — иначе eval
 * померяет не то, что делает бот.
 */

const BASE_URL = process.env.VISION_BASE_URL ?? "https://openrouter.ai/api/v1";

export type FailureKind = "bad_json" | "refusal" | "empty" | "http" | "network" | "timeout";

export interface CallOutcome {
  ok: boolean;
  failure?: FailureKind;
  /** Сырой ответ модели целиком — он нужен при разборе промахов. */
  raw: string;
  parsed?: {
    dishes: string[];
    grams: number;
    kcal: number;
    protein: number;
    fat: number;
    carbs: number;
    confidence?: number;
  };
  latencyMs: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  networkRetries: number;
  httpStatus?: number;
}

function imageToDataUrl(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}

/** Модель иногда оборачивает JSON в ```json — то же самое терпит и бот. */
function stripFences(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (m?.[1] ?? text).trim();
}

export async function callModel(params: {
  model: string;
  imagePath: string;
  apiKey: string;
  temperature: number;
  timeoutSec: number;
  networkRetries: number;
}): Promise<CallOutcome> {
  const dataUrl = imageToDataUrl(params.imagePath);
  const body = {
    model: params.model,
    temperature: params.temperature,
    usage: { include: true },
    messages: [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Проанализируй фото еды. ${JSON_RETRY_PROMPT}` },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
        ]
      }
    ]
  };

  let retries = 0;
  const startedAt = Date.now();

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutSec * 1000);
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "fithub eval"
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // 5xx и 429 — сторона провайдера, их повторяем; 4xx это наша ошибка в запросе
        if ((res.status >= 500 || res.status === 429) && retries < params.networkRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, 1000 * retries));
          continue;
        }
        return {
          ok: false, failure: "http", raw: text.slice(0, 4000), latencyMs: Date.now() - startedAt,
          costUsd: 0, promptTokens: 0, completionTokens: 0, networkRetries: retries, httpStatus: res.status
        };
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const latencyMs = Date.now() - startedAt;
      const raw = data.choices?.[0]?.message?.content ?? "";
      const usage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        costUsd: data.usage?.cost ?? 0
      };
      const common = { raw, latencyMs, networkRetries: retries, ...usage };

      if (!raw.trim()) return { ok: false, failure: "empty", ...common };

      let json: unknown;
      try {
        json = JSON.parse(stripFences(raw));
      } catch {
        return { ok: false, failure: "bad_json", ...common };
      }
      const parsed = foodResponseSchema.safeParse(json);
      if (!parsed.success) return { ok: false, failure: "bad_json", ...common };
      if (parsed.data.error || parsed.data.items.length === 0) return { ok: false, failure: "refusal", ...common };

      const items = parsed.data.items;
      const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((s, i) => s + f(i), 0);
      return {
        ok: true,
        ...common,
        parsed: {
          dishes: items.map((i) => i.dish),
          grams: sum((i) => i.grams),
          kcal: parsed.data.total?.kcal ?? sum((i) => i.kcal),
          protein: parsed.data.total?.protein ?? sum((i) => i.protein),
          fat: parsed.data.total?.fat ?? sum((i) => i.fat),
          carbs: parsed.data.total?.carbs ?? sum((i) => i.carbs),
          confidence: parsed.data.overall_confidence
        }
      };
    } catch (err) {
      const aborted = controller.signal.aborted;
      if (retries < params.networkRetries) {
        retries++;
        await new Promise((r) => setTimeout(r, 1000 * retries));
        continue;
      }
      return {
        ok: false, failure: aborted ? "timeout" : "network", raw: String(err),
        latencyMs: Date.now() - startedAt, costUsd: 0, promptTokens: 0, completionTokens: 0, networkRetries: retries
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
