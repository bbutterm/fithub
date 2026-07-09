// Единая фабрика OpenAI-совместимых ИИ-клиентов.
// Весь код обращается к моделям ТОЛЬКО через visionClient / textClient:
// смена провайдера или модели — правка .env без правок кода.
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { prisma } from "../db.js";

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BASE_PAUSE_MS = 1_000;

export type ChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
    >;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface CompletionOptions {
  model?: string; // переопределение модели (fallback-модель vision)
  maxTokens?: number;
  timeoutMs?: number;
  // Атрибуция вызова для учёта расходов в админке
  attribution?: { userId?: number; purpose: string };
}

export interface CompletionResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number; cost?: number };
  latencyMs: number;
  model: string;
}

/** 4xx от провайдера (неверная модель, ключ и т.п.) — ретраить бессмысленно. */
export class AiHttpError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`AI provider HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

/** 5xx / таймаут / сетевая ошибка — провайдер временно недоступен. */
export class AiUnavailableError extends Error {
  constructor(reason: string) {
    super(`AI provider unavailable: ${reason}`);
  }
}

const responseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().optional()
    })
    .optional()
});

export class AiClient {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly defaultModel: string
  ) {}

  private async attempt(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    const model = opts.model ?? this.defaultModel;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const body: Record<string, unknown> = { model, messages };
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      // OpenRouter умеет отдавать стоимость запроса в usage
      if (this.baseUrl.includes("openrouter")) body.usage = { include: true };

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": config.WEBAPP_URL,
            "X-Title": "AI Nutritionist Bot"
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        throw new AiUnavailableError(controller.signal.aborted ? "timeout" : String(err));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status >= 500) throw new AiUnavailableError(`HTTP ${res.status}`);
        throw new AiHttpError(res.status, text);
      }
      const data = responseSchema.parse(await res.json());
      const latencyMs = Date.now() - startedAt;
      const usage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        cost: data.usage?.cost
      };
      logger.info({ client: this.name, model, latencyMs, usage }, "ai call");
      this.recordUsage(model, usage, opts.attribution);
      return { text: data.choices[0]?.message.content ?? "", usage, latencyMs, model };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Стоимость вызова: цена от провайдера, если сообщил (OpenRouter), иначе по тарифам из конфига. */
  private calcCostUsd(usage: { promptTokens: number; completionTokens: number; cost?: number }): number {
    if (usage.cost !== undefined) return usage.cost;
    const inPrice = this.name === "vision" ? config.PRICE_VISION_INPUT_USD_PER_1M : config.PRICE_TEXT_INPUT_USD_PER_1M;
    const outPrice = this.name === "vision" ? config.PRICE_VISION_OUTPUT_USD_PER_1M : config.PRICE_TEXT_OUTPUT_USD_PER_1M;
    return (usage.promptTokens / 1e6) * inPrice + (usage.completionTokens / 1e6) * outPrice;
  }

  /** Запись расхода в БД для админки (fire-and-forget, ошибки не роняют запрос). */
  private recordUsage(
    model: string,
    usage: { promptTokens: number; completionTokens: number; cost?: number },
    attribution?: { userId?: number; purpose: string }
  ): void {
    void prisma.aiUsage
      .create({
        data: {
          userId: attribution?.userId ?? null,
          client: this.name,
          model,
          purpose: attribution?.purpose ?? "other",
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          costUsd: this.calcCostUsd(usage)
        }
      })
      .catch((err) => logger.warn({ err: String(err) }, "ai usage record failed"));
  }

  /** Вызов с 1 ретраем (экспоненциальная пауза) при таймауте/5xx/сетевой ошибке. */
  async chatCompletion(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(messages, opts);
      } catch (err) {
        if (attempt >= 1 || !(err instanceof AiUnavailableError)) throw err;
        const pause = RETRY_BASE_PAUSE_MS * 2 ** attempt;
        logger.warn({ client: this.name, attempt, pause, err: String(err) }, "ai call failed, retrying");
        await new Promise((r) => setTimeout(r, pause));
      }
    }
  }

  /**
   * Вызов с ожиданием JSON по zod-схеме.
   * При невалидном JSON — один повтор с уточнением «верни только JSON».
   */
  async chatCompletionJson<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    retryPrompt: string,
    opts: CompletionOptions = {}
  ): Promise<{ value: T; latencyMs: number }> {
    let lastRaw = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const msgs: ChatMessage[] =
        attempt === 0
          ? messages
          : [...messages, { role: "assistant", content: lastRaw.slice(0, 4000) }, { role: "user", content: retryPrompt }];
      const res = await this.chatCompletion(msgs, opts);
      lastRaw = res.text;
      try {
        const parsed: unknown = JSON.parse(stripJsonFences(res.text));
        return { value: schema.parse(parsed), latencyMs: res.latencyMs };
      } catch (err) {
        logger.warn(
          { client: this.name, attempt, err: String(err), raw: res.text.slice(0, 500) },
          "invalid JSON from model"
        );
      }
    }
    throw new Error("MODEL_JSON_INVALID");
  }

  /** Короткий completion для проверки провайдера при старте. Никогда не бросает. */
  async probe(): Promise<void> {
    try {
      await this.attempt([{ role: "user", content: "ping" }], { maxTokens: 1, timeoutMs: 10_000 });
      logger.info({ client: this.name, model: this.defaultModel }, "ai provider probe ok");
    } catch (err) {
      if (err instanceof AiHttpError && /model/i.test(err.body)) {
        const hint = await this.suggestModels();
        logger.error(
          { client: this.name, model: this.defaultModel, status: err.status, availableModels: hint },
          `Модель «${this.defaultModel}» не найдена или устарела. Подставьте актуальное имя в ${this.name === "text" ? "TEXT_MODEL" : "VISION_MODEL"} в .env${hint.length ? ` (похоже, доступны: ${hint.join(", ")})` : ""}.`
        );
      } else {
        logger.warn({ client: this.name, err: String(err) }, "ai provider probe failed (приложение продолжит работу)");
      }
    }
  }

  /** Пытается получить список моделей провайдера для подсказки в логе. */
  private async suggestModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
      const family = this.defaultModel.split(/[-/]/)[0] ?? "";
      return ids.filter((id) => family && id.toLowerCase().includes(family.toLowerCase())).slice(0, 5);
    } catch {
      return [];
    }
  }
}

/** Срезает markdown-фенсы вокруг JSON, если модель их добавила. */
export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) s = fence[1].trim();
  // иногда модель добавляет текст до/после JSON — вырезаем крайние скобки
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first > 0 || (last >= 0 && last < s.length - 1)) {
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  return s;
}

/** Только распознавание фото еды (+ текстовая деградация text-провайдера, см. ai/food.ts). */
export const visionClient = new AiClient("vision", config.VISION_BASE_URL, config.VISION_API_KEY, config.VISION_MODEL);

/** Всё текстовое: советы, отчёты, разбор текстовых описаний еды. */
export const textClient = new AiClient("text", config.TEXT_BASE_URL, config.TEXT_API_KEY, config.TEXT_MODEL);

let probed = false;
/** Probe обоих провайдеров при старте: не падает, но подсказывает в логе актуальные имена моделей. */
export function probeProvidersOnce(): void {
  if (probed) return;
  probed = true;
  void visionClient.probe();
  void textClient.probe();
}
