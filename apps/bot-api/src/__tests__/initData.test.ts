import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateInitData } from "../auth/initData.js";

const BOT_TOKEN = "1234567:TEST_TOKEN_ABC";

function buildInitData(params: Record<string, string>, token: string = BOT_TOKEN): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const sp = new URLSearchParams(entries);
  sp.append("hash", hash);
  return sp.toString();
}

const now = new Date("2026-07-09T12:00:00Z");
const freshAuthDate = String(Math.floor(now.getTime() / 1000) - 60);
const userJson = JSON.stringify({ id: 42, first_name: "Тест", username: "test" });

describe("validateInitData", () => {
  it("принимает валидный initData", () => {
    const initData = buildInitData({ auth_date: freshAuthDate, user: userJson, query_id: "AAA" });
    const res = validateInitData(initData, BOT_TOKEN, now);
    expect(res).not.toBeNull();
    expect(res?.user.id).toBe(42);
  });

  it("отклоняет подделанный hash", () => {
    const initData = buildInitData({ auth_date: freshAuthDate, user: userJson });
    const forged = initData.replace(/hash=\w+/, "hash=" + "0".repeat(64));
    expect(validateInitData(forged, BOT_TOKEN, now)).toBeNull();
  });

  it("отклоняет initData, подписанный чужим токеном", () => {
    const initData = buildInitData({ auth_date: freshAuthDate, user: userJson }, "999:OTHER");
    expect(validateInitData(initData, BOT_TOKEN, now)).toBeNull();
  });

  it("отклоняет подмену user после подписи", () => {
    const initData = buildInitData({ auth_date: freshAuthDate, user: userJson });
    const tampered = initData.replace(encodeURIComponent(userJson), encodeURIComponent(userJson.replace('"id":42', '"id":1')));
    expect(validateInitData(tampered, BOT_TOKEN, now)).toBeNull();
  });

  it("отклоняет протухший auth_date (старше 24 часов)", () => {
    const old = String(Math.floor(now.getTime() / 1000) - 25 * 3600);
    const initData = buildInitData({ auth_date: old, user: userJson });
    expect(validateInitData(initData, BOT_TOKEN, now)).toBeNull();
  });

  it("отклоняет initData без hash и мусор", () => {
    expect(validateInitData("auth_date=1&user=%7B%7D", BOT_TOKEN, now)).toBeNull();
    expect(validateInitData("", BOT_TOKEN, now)).toBeNull();
  });
});
