import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// Час с запасом: ссылка живёт столько, сколько открыт экран дневника.
// Дальше Mini App перезапрашивает список приёмов и получает свежие подписи.
const TTL_MS = 60 * 60 * 1000;

function sign(mealId: number, uid: number, expMs: number): string {
  return createHmac("sha256", config.photoSecret)
    .update(`${mealId}:${uid}:${expMs}`)
    .digest("base64url");
}

/**
 * Подпись для ссылки на фото приёма пищи.
 *
 * Раньше в адрес картинки подставлялся обычный сессионный JWT — двенадцатичасовой
 * токен полного доступа, который попадал в логи, в кэш WebView и в любой прокси
 * по дороге. Эта подпись даёт ровно одно право: прочитать фото одного приёма,
 * и живёт час.
 */
export function signPhotoToken(mealId: number, uid: number, now: number = Date.now()): string {
  const exp = now + TTL_MS;
  return `${uid}.${exp}.${sign(mealId, uid, exp)}`;
}

/** Возвращает id пользователя, которому выдана подпись, либо null. */
export function verifyPhotoToken(token: string, mealId: number, now: number = Date.now()): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uidRaw, expRaw, sig] = parts as [string, string, string];

  const uid = Number(uidRaw);
  const exp = Number(expRaw);
  if (!Number.isInteger(uid) || !Number.isFinite(exp) || exp < now) return null;

  const expected = sign(mealId, uid, exp);
  // Сравнение постоянного времени: иначе по задержке ответа подпись подбирается побайтно
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return uid;
}
