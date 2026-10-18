import { describe, expect, it, vi } from "vitest";

vi.mock("../telegram", () => ({ getRawInitData: () => "", webApp: () => undefined }));

const { photoUrl } = await import("../api");

describe("ссылка на фото приёма", () => {
  it("подставляет подпись приёма", () => {
    expect(photoUrl({ id: 7, photoToken: "abc.123.sig" })).toBe("/api/photos/7?t=abc.123.sig");
  });

  it("просит превью отдельным флагом", () => {
    expect(photoUrl({ id: 7, photoToken: "abc" }, true)).toBe("/api/photos/7?t=abc&thumb=1");
  });

  it("без подписи не подставляет «null» в адрес", () => {
    expect(photoUrl({ id: 7, photoToken: null })).toBe("/api/photos/7?t=");
  });

  it("экранирует подпись со спецсимволами", () => {
    expect(photoUrl({ id: 7, photoToken: "a+b/c=" })).toBe("/api/photos/7?t=a%2Bb%2Fc%3D");
  });
});
