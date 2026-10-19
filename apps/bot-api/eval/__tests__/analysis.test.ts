import { describe, expect, it } from "vitest";
import { bestPairs, calibrate, confidenceSignal, median, runsBenefit, splitError } from "../src/analysis.js";
import type { StoredCall } from "../src/storage.js";
import type { Truth } from "../src/metrics.js";

const truth = (file: string, kcal: number, grams: number): Truth => ({
  file, kcal, grams, protein: 10, fat: 10, carbs: 10, tags: ["simple"]
});

const call = (model: string, file: string, kcal: number, grams: number, run = 1, confidence = 0.9): StoredCall => ({
  model, file, run, at: "", ok: true, latencyMs: 1000, costUsd: 0.001,
  promptTokens: 0, completionTokens: 0, networkRetries: 0,
  parsed: { dishes: ["блюдо"], grams, kcal, protein: 10, fat: 10, carbs: 10, confidence },
  raw: ""
});

describe("медиана", () => {
  it("на чётном наборе берёт середину между двумя", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5])).toBe(5);
    expect(median([])).toBeNaN();
  });
});

describe("разложение ошибки на вес и состав", () => {
  it("ошибка только в весе: состав после пересчёта безупречен", () => {
    // Вдвое больше граммов и вдвое больше калорий — сама еда определена верно
    const calls = [call("m", "a.jpg", 1000, 400)];
    const r = splitError("m", calls, [truth("a.jpg", 500, 200)]);
    expect(r.totalPct).toBe(100);
    expect(r.weightPct).toBe(100);
    expect(r.compositionPct).toBe(0);
    expect(r.weightSharePct).toBe(100);
  });

  it("ошибка только в составе: вес угадан, калории нет", () => {
    const calls = [call("m", "a.jpg", 750, 200)];
    const r = splitError("m", calls, [truth("a.jpg", 500, 200)]);
    expect(r.weightPct).toBe(0);
    expect(r.compositionPct).toBe(50);
    expect(r.weightSharePct).toBe(0);
  });

  it("без ошибок всё по нулям", () => {
    const r = splitError("m", [call("m", "a.jpg", 500, 200)], [truth("a.jpg", 500, 200)]);
    expect(r).toMatchObject({ totalPct: 0, weightPct: 0, compositionPct: 0 });
  });
});

describe("поправочный коэффициент", () => {
  it("постоянное завышение лечится множителем", () => {
    const calls = [call("m", "a.jpg", 600, 200), call("m", "b.jpg", 1200, 400)];
    const r = calibrate("m", calls, [truth("a.jpg", 500, 200), truth("b.jpg", 1000, 400)]);
    expect(r.factor).toBeCloseTo(0.833, 2);
    expect(r.before).toBe(20);
    expect(r.after).toBe(0);
  });

  it("случайный разброс множителем не чинится", () => {
    const calls = [call("m", "a.jpg", 300, 200), call("m", "b.jpg", 700, 200)];
    const r = calibrate("m", calls, [truth("a.jpg", 500, 200), truth("b.jpg", 500, 200)]);
    expect(r.after).toBeGreaterThan(10);
  });
});

describe("польза нескольких прогонов", () => {
  it("медиана трёх ответов точнее одного, когда модель шумит", () => {
    const calls = [
      call("m", "a.jpg", 900, 200, 1), call("m", "a.jpg", 500, 200, 2), call("m", "a.jpg", 480, 200, 3)
    ];
    const r = runsBenefit("m", calls, [truth("a.jpg", 500, 200)]);
    expect(r.single).toBe(80);
    expect(r.medianOfRuns).toBe(0);
    expect(r.runs).toBe(3);
  });

  it("у стабильной модели выигрыша нет", () => {
    const calls = [call("m", "a.jpg", 500, 200, 1), call("m", "a.jpg", 500, 200, 2)];
    const r = runsBenefit("m", calls, [truth("a.jpg", 500, 200)]);
    expect(r.single).toBe(r.medianOfRuns);
  });
});

describe("пары моделей", () => {
  it("две ошибки в разные стороны гасят друг друга", () => {
    const calls = [call("a", "x.jpg", 400, 200), call("b", "x.jpg", 600, 200)];
    const [pair] = bestPairs(["a", "b"], calls, [truth("x.jpg", 500, 200)]);
    expect(pair!.pairPct).toBe(0);
    expect(pair!.bestSinglePct).toBe(20);
    expect(pair!.gainPct).toBe(20);
    expect(pair!.costUsd).toBe(0.002);
  });

  it("две одинаковые ошибки в одну сторону пара не исправляет", () => {
    const calls = [call("a", "x.jpg", 600, 200), call("b", "x.jpg", 600, 200)];
    const [pair] = bestPairs(["a", "b"], calls, [truth("x.jpg", 500, 200)]);
    expect(pair!.gainPct).toBe(0);
  });
});

describe("самооценка модели", () => {
  it("низкая уверенность действительно предсказывает промах", () => {
    const calls = [
      call("m", "a.jpg", 500, 200, 1, 0.9), call("m", "b.jpg", 510, 200, 1, 0.95),
      call("m", "c.jpg", 900, 200, 1, 0.4)
    ];
    const r = confidenceSignal("m", calls, [truth("a.jpg", 500, 200), truth("b.jpg", 500, 200), truth("c.jpg", 500, 200)]);
    expect(r.useful).toBe(true);
    expect(r.errorBelow).toBeGreaterThan(r.errorAbove);
  });

  it("если ошибка одинакова, переспрашивать по уверенности бессмысленно", () => {
    const calls = [call("m", "a.jpg", 600, 200, 1, 0.9), call("m", "b.jpg", 600, 200, 1, 0.4)];
    const r = confidenceSignal("m", calls, [truth("a.jpg", 500, 200), truth("b.jpg", 500, 200)]);
    expect(r.useful).toBe(false);
  });
});
