import { addDays, localDateStr, zonedTimeToUtc } from "../utils/tz.js";
import { PURCHASES_UNAVAILABLE_TEXT } from "./payments.js";

/** Общий текст при исчерпанном дневном лимите: фото, текст и голосовые. */
export function limitReachedText(limit: number): string {
  return [
    `Дневной лимит распознаваний (${limit}) на сегодня исчерпан 😌 Попробуй завтра.`,
    "",
    PURCHASES_UNAVAILABLE_TEXT
  ].join("\n");
}

/** Распознавание не должно пережить лимит serverless-функции. */
export class RecognitionTimeoutError extends Error {
  constructor() {
    super("recognition timeout");
  }
}

/** «ел в 8:30 (вчера)» → UTC-инстант в таймзоне пользователя. */
export function eatenTimeToUtc(eaten: { day: "today" | "yesterday"; time: string }, tz: string): Date {
  const date = eaten.day === "yesterday" ? addDays(localDateStr(tz), -1) : localDateStr(tz);
  const time = eaten.time.length === 4 ? `0${eaten.time}` : eaten.time; // "8:30" → "08:30"
  return zonedTimeToUtc(date, time, tz);
}

