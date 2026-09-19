import { describe, expect, it } from "vitest";
import { nextStepHint } from "../services/nextStep.js";

const base = { hourLocal: 19, dayKcal: 1200, dayProtein: 60, targetKcal: 2000, targetProtein: 120, dietType: "none" as const };

describe("nextStepHint", () => {
  it("перебор калорий — стоп, независимо от часа", () => {
    expect(nextStepHint({ ...base, hourLocal: 10, dayKcal: 2300 })).toContain("+300 ккал");
  });

  it("вечером и белка мало — подсказка с источниками под тип питания", () => {
    expect(nextStepHint(base)).toContain("60 г");
    expect(nextStepHint({ ...base, dietType: "vegan" })).toContain("тофу");
    expect(nextStepHint({ ...base, dietType: "vegan" })).not.toContain("творог");
  });

  it("днём про белок молчим, без целей молчим, при малом недоборе молчим", () => {
    expect(nextStepHint({ ...base, hourLocal: 12 })).toBeNull();
    expect(nextStepHint({ ...base, targetKcal: null, targetProtein: null })).toBeNull();
    expect(nextStepHint({ ...base, dayProtein: 100 })).toBeNull();
  });

  it("небольшое превышение (до 5%) не считается перебором", () => {
    expect(nextStepHint({ ...base, hourLocal: 12, dayKcal: 2080 })).toBeNull();
  });
});
