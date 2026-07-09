import { createHmac } from "node:crypto";

export interface InitDataUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface ValidatedInitData {
  user: InitDataUser;
  authDate: Date;
}

const AUTH_DATE_TTL_SEC = 24 * 3600;

/**
 * Валидация initData Mini App по алгоритму Telegram:
 * secret = HMAC_SHA256(botToken, key="WebAppData"); hash = HMAC_SHA256(data_check_string, secret).
 * Источник истины — только tgUserId из проверенной строки. TTL auth_date — 24 часа.
 */
export function validateInitData(
  initData: string,
  botToken: string,
  now: Date = new Date()
): ValidatedInitData | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (expected !== hash) return null;

  const authDateSec = Number(params.get("auth_date"));
  if (!Number.isFinite(authDateSec)) return null;
  const ageSec = now.getTime() / 1000 - authDateSec;
  if (ageSec > AUTH_DATE_TTL_SEC || ageSec < -300) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as InitDataUser;
    if (typeof user.id !== "number") return null;
    return { user, authDate: new Date(authDateSec * 1000) };
  } catch {
    return null;
  }
}
