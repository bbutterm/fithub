import { describe, expect, it } from "vitest";
import { signPhotoToken, verifyPhotoToken } from "../auth/photoToken.js";

const MEAL = 42;
const UID = 7;

describe("signPhotoToken / verifyPhotoToken", () => {
  it("своя подпись проходит проверку и возвращает владельца", () => {
    expect(verifyPhotoToken(signPhotoToken(MEAL, UID), MEAL)).toBe(UID);
  });

  it("подпись привязана к приёму: для другого mealId не годится", () => {
    const token = signPhotoToken(MEAL, UID);
    expect(verifyPhotoToken(token, MEAL + 1)).toBeNull();
  });

  it("истёкшая подпись отклоняется", () => {
    const issuedAt = Date.now() - 2 * 60 * 60 * 1000; // два часа назад
    const token = signPhotoToken(MEAL, UID, issuedAt);
    expect(verifyPhotoToken(token, MEAL)).toBeNull();
  });

  it("подделать срок жизни, не пересчитав подпись, нельзя", () => {
    const [uid, , sig] = signPhotoToken(MEAL, UID).split(".") as [string, string, string];
    const forged = `${uid}.${Date.now() + 10 * 365 * 24 * 3600 * 1000}.${sig}`;
    expect(verifyPhotoToken(forged, MEAL)).toBeNull();
  });

  it("подменить пользователя в подписи нельзя", () => {
    const [, exp, sig] = signPhotoToken(MEAL, UID).split(".") as [string, string, string];
    expect(verifyPhotoToken(`${UID + 1}.${exp}.${sig}`, MEAL)).toBeNull();
  });

  it("мусор вместо токена не проходит и не бросает исключение", () => {
    for (const bad of ["", ".", "a.b", "a.b.c", "1.2.3.4", "нетокен"]) {
      expect(verifyPhotoToken(bad, MEAL)).toBeNull();
    }
  });

  it("подпись длиннее и короче ожидаемой отклоняется без падения", () => {
    const [uid, exp] = signPhotoToken(MEAL, UID).split(".") as [string, string, string];
    expect(verifyPhotoToken(`${uid}.${exp}.x`, MEAL)).toBeNull();
    expect(verifyPhotoToken(`${uid}.${exp}.${"x".repeat(200)}`, MEAL)).toBeNull();
  });
});
