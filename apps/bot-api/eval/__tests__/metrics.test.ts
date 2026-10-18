import { describe, expect, it } from "vitest";
import {
  comparisonIsMeaningful, failedThresholds, median, percentile, summarize, worstMisses,
  type CallRecord, type Truth
} from "../src/metrics.js";

const truth = (file: string, over: Partial<Truth> = {}): Truth => ({
  file, grams: 300, kcal: 500, protein: 30, fat: 20, carbs: 50, tags: ["simple"], ...over
});

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  model: "m1", file: "a.jpg", run: 1, ok: true,
  grams: 300, kcal: 500, protein: 30, fat: 20, carbs: 50,
  latencyMs: 2000, costUsd: 0.001, networkRetries: 0, ...over
});

describe("базовая статистика", () => {
  it("медиана и перцентиль считаются по рангу", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it("на пустом наборе возвращается NaN, а не ноль", () => {
    expect(median([])).toBeNaN();
    expect(percentile([], 90)).toBeNaN();
  });
});

describe("сводка по модели", () => {
  it("точный ответ даёт нулевую ошибку", () => {
    const m = summarize("m1", [call()], [truth("a.jpg")]);
    expect(m.kcalErrorPctMean).toBe(0);
    expect(m.failureRatePct).toBe(0);
    expect(m.costPerPhotoUsd).toBe(0.001);
  });

  it("завышение видно по знаку ошибки, занижение — тоже", () => {
    const high = summarize("m1", [call({ kcal: 600 })], [truth("a.jpg")]);
    expect(high.kcalErrorPctMean).toBe(20);
    expect(high.kcalBiasPctMean).toBe(20);

    const low = summarize("m1", [call({ kcal: 400 })], [truth("a.jpg")]);
    expect(low.kcalErrorPctMean).toBe(20);
    expect(low.kcalBiasPctMean).toBe(-20);
  });

  it("сбои считаются долей вызовов и не искажают точность", () => {
    const m = summarize("m1", [call(), call({ run: 2, ok: false, failure: "bad_json", kcal: undefined })], [truth("a.jpg")]);
    expect(m.failureRatePct).toBe(50);
    expect(m.kcalErrorPctMean).toBe(0); // считается только по разобранным ответам
  });

  it("фото весит одинаково, сколько бы прогонов по нему ни прошло", () => {
    // По первому фото три прогона с нулевой ошибкой, по второму один с ошибкой 40%
    const calls = [
      call({ file: "a.jpg", run: 1 }), call({ file: "a.jpg", run: 2 }), call({ file: "a.jpg", run: 3 }),
      call({ file: "b.jpg", kcal: 700 })
    ];
    const m = summarize("m1", calls, [truth("a.jpg"), truth("b.jpg")]);
    expect(m.kcalErrorPctMean).toBe(20); // среднее из 0% и 40%, а не из четырёх вызовов
  });

  it("разброс между прогонами считается в процентах от эталона", () => {
    const calls = [call({ run: 1, kcal: 450 }), call({ run: 2, kcal: 500 }), call({ run: 3, kcal: 550 })];
    expect(summarize("m1", calls, [truth("a.jpg")]).runSpreadPctMean).toBe(20);
  });

  it("ошибки по весу и макросам считаются отдельно", () => {
    const m = summarize("m1", [call({ grams: 360, protein: 36, fat: 25, carbs: 45 })], [truth("a.jpg")]);
    expect(m.gramsErrorPctMean).toBe(20);
    expect(m.proteinErrorGMean).toBe(6);
    expect(m.fatErrorGMean).toBe(5);
    expect(m.carbsErrorGMean).toBe(5);
  });

  it("ручная разметка названий превращается в проценты", () => {
    const verdicts = new Map([["m1|a.jpg|1", "верно" as const], ["m1|b.jpg|1", "мимо" as const]]);
    const m = summarize("m1", [call({ file: "a.jpg" }), call({ file: "b.jpg" })], [truth("a.jpg"), truth("b.jpg")], verdicts);
    expect(m.dishCorrectPct).toBe(50);
    expect(m.dishMissPct).toBe(50);
  });

  it("чужие вызовы в сводку не попадают", () => {
    const m = summarize("m1", [call(), call({ model: "m2", kcal: 1000 })], [truth("a.jpg")]);
    expect(m.calls).toBe(1);
    expect(m.kcalErrorPctMean).toBe(0);
  });
});

describe("пороги раздела 1", () => {
  const thresholds = { kcalErrorPctMean: 20, costPerPhotoUsd: 0.004, latencySecP95: 10, failureRatePct: 5 };

  it("модель в пределах порогов проходит", () => {
    const m = summarize("m1", [call()], [truth("a.jpg")]);
    expect(failedThresholds(m, thresholds)).toEqual([]);
  });

  it("каждый нарушенный порог называется отдельно", () => {
    const m = summarize("m1", [call({ kcal: 800, costUsd: 0.01, latencyMs: 30_000 })], [truth("a.jpg")]);
    const failed = failedThresholds(m, thresholds);
    expect(failed).toHaveLength(3);
    expect(failed.join(" ")).toContain("ошибка по ккал");
    expect(failed.join(" ")).toContain("цена");
    expect(failed.join(" ")).toContain("время");
  });

  it("ровно на пороге модель ещё проходит", () => {
    const m = summarize("m1", [call({ kcal: 600 })], [truth("a.jpg")]); // ровно 20%
    expect(failedThresholds(m, thresholds)).toEqual([]);
  });
});

describe("разница против шума", () => {
  it("разрыв больше разброса — сравнивать можно", () => {
    const a = summarize("a", [call({ model: "a", run: 1, kcal: 500 }), call({ model: "a", run: 2, kcal: 505 })], [truth("a.jpg")]);
    const b = summarize("b", [call({ model: "b", run: 1, kcal: 700 }), call({ model: "b", run: 2, kcal: 705 })], [truth("a.jpg")]);
    expect(comparisonIsMeaningful(a, b).meaningful).toBe(true);
  });

  it("разрыв меньше разброса — это шум", () => {
    const a = summarize("a", [call({ model: "a", run: 1, kcal: 400 }), call({ model: "a", run: 2, kcal: 600 })], [truth("a.jpg")]);
    const b = summarize("b", [call({ model: "b", run: 1, kcal: 410 }), call({ model: "b", run: 2, kcal: 590 })], [truth("a.jpg")]);
    const check = comparisonIsMeaningful(a, b);
    expect(check.meaningful).toBe(false);
    expect(check.noise).toBeGreaterThan(check.gap);
  });
});

describe("худшие промахи", () => {
  it("возвращаются самые большие ошибки по убыванию", () => {
    const calls = [call({ file: "a.jpg", kcal: 520 }), call({ file: "b.jpg", kcal: 900 }), call({ file: "c.jpg", kcal: 700 })];
    const misses = worstMisses("m1", calls, [truth("a.jpg"), truth("b.jpg"), truth("c.jpg")], 2);
    expect(misses.map((m) => m.truth.file)).toEqual(["b.jpg", "c.jpg"]);
  });

  it("сбойные вызовы в промахи не попадают: там нечего смотреть", () => {
    const calls = [call({ file: "a.jpg", ok: false, kcal: undefined })];
    expect(worstMisses("m1", calls, [truth("a.jpg")])).toEqual([]);
  });
});
