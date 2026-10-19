import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, lowerIsBetter, scoreModel } from "../src/scoring.js";
import type { ModelMetrics } from "../src/metrics.js";

const base = (over: Partial<ModelMetrics> = {}): ModelMetrics => ({
  model: "m", photos: 50, calls: 150,
  failureRatePct: 0, networkRetries: 0,
  kcalErrorPctMean: 0, kcalErrorPctMedian: 0, kcalErrorPctP90: 0, kcalErrorAbsMean: 0, kcalBiasPctMean: 0,
  gramsErrorPctMean: 0, macroErrorPctMean: 0, proteinErrorGMean: 0, fatErrorGMean: 0, carbsErrorGMean: 0,
  runSpreadPctMean: 0, latencySecMean: 1, latencySecP95: 2, costPerPhotoUsd: 0.0003,
  ...over
});

describe("шкала «меньше — лучше»", () => {
  it("идеальное значение даёт сто, провальное — ноль", () => {
    expect(lowerIsBetter(0, 0, 40)).toBe(100);
    expect(lowerIsBetter(40, 0, 40)).toBe(0);
    expect(lowerIsBetter(20, 0, 40)).toBe(50);
  });

  it("за пределами шкалы значения не уходят в минус и за сотню", () => {
    expect(lowerIsBetter(80, 0, 40)).toBe(0);
    expect(lowerIsBetter(-5, 0, 40)).toBe(100);
  });

  it("отсутствующая метрика — ноль баллов, а не молчаливая сотня", () => {
    expect(lowerIsBetter(NaN, 0, 40)).toBe(0);
  });
});

describe("сводный балл", () => {
  it("идеальная модель набирает сто по всем критериям", () => {
    expect(scoreModel(base())).toMatchObject({ kcal: 100, macros: 100, portion: 100, reliability: 100, speed: 100, price: 100, total: 100 });
  });

  it("ошибка по калориям бьёт сильнее ошибки по цене: у неё больший вес", () => {
    const sloppy = scoreModel(base({ kcalErrorPctMean: 20 }));
    const pricey = scoreModel(base({ costPerPhotoUsd: 0.006 }));
    expect(sloppy.total).toBeLessThan(pricey.total);
  });

  it("сбои снижают надёжность сильнее, чем разброс между прогонами", () => {
    const failing = scoreModel(base({ failureRatePct: 10 }));
    const unstable = scoreModel(base({ runSpreadPctMean: 10 }));
    expect(failing.reliability).toBeLessThan(unstable.reliability);
  });

  it("вес порции и состав считаются отдельно", () => {
    const badPortion = scoreModel(base({ gramsErrorPctMean: 25 }));
    expect(badPortion.portion).toBe(50);
    expect(badPortion.macros).toBe(100);
  });

  it("веса задают итог: с одним критерием балл равен его собственному", () => {
    const m = base({ kcalErrorPctMean: 20, costPerPhotoUsd: 0.006 });
    const zero = { kcal: 0, macros: 0, portion: 0, reliability: 0, speed: 0, price: 0 };
    expect(scoreModel(m, { ...zero, kcal: 1 }).total).toBe(50);
    expect(scoreModel(m, { ...zero, price: 1 }).total).toBe(0);
    // С весами по умолчанию обе беды размазываются по шести критериям
    expect(scoreModel(m, DEFAULT_WEIGHTS).total).toBeGreaterThan(50);
  });

  it("совсем плохая модель получает ноль, а не отрицательное число", () => {
    const awful = scoreModel(base({ kcalErrorPctMean: 200, macroErrorPctMean: 300, gramsErrorPctMean: 200, failureRatePct: 100, latencySecP95: 60, costPerPhotoUsd: 1 }));
    expect(awful.total).toBe(0);
  });
});
