import { createHmac } from "node:crypto";
import type { buildServer } from "../../api/server.js";
import type { Update } from "grammy/types";
import { prisma } from "../../db.js";
import { config } from "../../config.js";

/** Сервер со всеми его типами логгера: FastifyInstance по умолчанию сюда не подходит. */
export type TestApp = Awaited<ReturnType<typeof buildServer>>;

/** Подписанная initData, как её присылает Telegram Mini App. */
export function signInitData(user: { id: number; first_name?: string }, authDateSec = Math.floor(Date.now() / 1000)): string {
  const params = new URLSearchParams({ auth_date: String(authDateSec), user: JSON.stringify(user) });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(config.BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

/** Логин через настоящий маршрут: заодно создаёт пользователя. */
export async function login(app: TestApp, tgId: number, firstName = "Тест") {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/telegram",
    payload: { initData: signInitData({ id: tgId, first_name: firstName }) }
  });
  const body = res.json() as { token: string; user: { id: number } };
  return { token: body.token, userId: body.user.id, auth: { authorization: `Bearer ${body.token}` } };
}

export async function makeProfile(userId: number, over: Record<string, unknown> = {}) {
  return prisma.profile.create({
    data: {
      userId,
      gender: "male",
      birthYear: 1990,
      heightCm: 180,
      weightKg: 80,
      targetKcal: 2000,
      targetProtein: 120,
      targetFat: 65,
      targetCarbs: 220,
      updatedAt: new Date(),
      ...over
    }
  });
}

export async function makeMeal(
  userId: number,
  over: { dish?: string; kcal?: number; protein?: number; eatenAt?: Date; photoFileId?: string | null } = {}
) {
  const kcal = over.kcal ?? 500;
  const protein = over.protein ?? 30;
  return prisma.meal.create({
    data: {
      userId,
      source: "photo",
      eatenAt: over.eatenAt ?? new Date(),
      photoFileId: over.photoFileId === undefined ? "file_test" : over.photoFileId,
      totalKcal: kcal,
      totalProtein: protein,
      totalFat: 20,
      totalCarbs: 50,
      items: { create: [{ dish: over.dish ?? "тестовое блюдо", grams: 300, kcal, protein, fat: 20, carbs: 50, confidence: 0.9 }] }
    },
    include: { items: true }
  });
}

/** Перехват вызовов Bot API: наружу ничего не уходит, всё отправленное видно в массиве. */
export interface SentMessage {
  method: string;
  chatId?: number;
  text?: string;
  buttons: string[];
  data: string[];
}

export function captureBotApi(bot: { api: { config: { use: (fn: never) => void } } }, botUsername = "Fithub_ai_bot") {
  const sent: SentMessage[] = [];
  let messageId = 1000;
  const transformer = async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
    if (method === "getMe") {
      return { ok: true, result: { id: 1, is_bot: true, first_name: "bot", username: botUsername } };
    }
    const rm = payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } | undefined;
    const flat = (rm?.inline_keyboard ?? []).flat();
    if (method === "sendMessage" || method === "editMessageText" || method === "answerCallbackQuery") {
      sent.push({
        method,
        chatId: Number(payload.chat_id ?? 0) || undefined,
        text: String(payload.text ?? ""),
        buttons: flat.map((b) => b.text),
        data: flat.map((b) => b.callback_data ?? "")
      });
      if (method === "answerCallbackQuery") return { ok: true, result: true };
      return { ok: true, result: { message_id: ++messageId, date: 0, chat: { id: Number(payload.chat_id ?? 0) }, text: payload.text } };
    }
    sent.push({ method, buttons: [], data: [] });
    return { ok: true, result: true };
  };
  bot.api.config.use(transformer as never);
  return {
    sent,
    clear: () => (sent.length = 0),
    last: () => [...sent].reverse().find((s) => s.text) ?? null,
    texts: () => sent.map((s) => s.text ?? "").join("\n")
  };
}

let updateId = 1;
export function textUpdate(chatId: number, from: { id: number; first_name?: string }, text: string): Update {
  const cmdLen = text.startsWith("/") ? (text.split(" ")[0] ?? "").length : 0;
  return {
    update_id: updateId++,
    message: {
      message_id: 500 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      from: { is_bot: false, first_name: "Тест", ...from },
      text,
      ...(cmdLen ? { entities: [{ type: "bot_command", offset: 0, length: cmdLen }] } : {})
    }
  } as Update;
}

export function callbackUpdate(chatId: number, from: { id: number }, data: string): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { is_bot: false, first_name: "Тест", ...from },
      chat_instance: "x",
      data,
      message: { message_id: 900 + updateId, date: 0, chat: { id: chatId, type: "private" }, text: "…" }
    }
  } as Update;
}

/** Московские сутки: вся логика рассылок завязана на местный вечер. */
export const mskDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const mskAt = (isoDate: string, time: string) => new Date(`${isoDate}T${time}:00+03:00`);
