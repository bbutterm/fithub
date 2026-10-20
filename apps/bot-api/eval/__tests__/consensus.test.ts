import { describe, expect, it } from "vitest";
import { agreement, photoConsensus } from "../src/consensus.js";
import type { StoredCall } from "../src/storage.js";

const call = (model: string, file: string, kcal: number, over: Partial<StoredCall> = {}): StoredCall => ({
  model, file, run: 1, at: "", ok: true, latencyMs: 5000, costUsd: 0.001,
  promptTokens: 0, completionTokens: 0, networkRetries: 0,
  parsed: { dishes: ["омлет"], grams: 200, kcal, protein: 10, fat: 10, carbs: 10, confidence: 0.9 },
  raw: "", ...over
});

describe("photoConsensus", () => {
  it("считает общее мнение и разброс, снимки идут от самого спорного", () => {
    const calls = [
      call("a", "1.jpg", 100), call("b", "1.jpg", 110), call("c", "1.jpg", 120),
      call("a", "2.jpg", 100), call("b", "2.jpg", 300), call("c", "2.jpg", 500)
    ];
    const rows = photoConsensus(calls);
    expect(rows[0]!.file).toBe("2.jpg");
    expect(rows[0]!.spreadRatio).toBe(5);
    expect(rows[1]!.consensusKcal).toBe(110);
    expect(rows[1]!.spreadRatio).toBe(1.2);
  });

  it("сбои в расчёт не идут, а названия блюд собираются по частоте", () => {
    const calls = [
      call("a", "1.jpg", 100),
      call("b", "1.jpg", 100),
      call("c", "1.jpg", 999, { parsed: { dishes: ["борщ"], grams: 200, kcal: 999, protein: 1, fat: 1, carbs: 1 } }),
      call("d", "1.jpg", 0, { ok: false, failure: "bad_json", parsed: undefined })
    ];
    const rows = photoConsensus(calls);
    expect(rows[0]!.models).toBe(3);
    expect(rows[0]!.dishes).toEqual(["омлет", "борщ"]);
  });
});

describe("agreement", () => {
  const calls = [
    // «щедрая» всегда выше остальных, «обычная» и «вторая» держатся вместе
    call("щедрая", "1.jpg", 200), call("обычная", "1.jpg", 100), call("вторая", "1.jpg", 100),
    call("щедрая", "2.jpg", 400), call("обычная", "2.jpg", 200), call("вторая", "2.jpg", 200)
  ];

  it("показывает, кто выбивается, и в какую сторону", () => {
    const rows = agreement(calls);
    expect(rows[0]!.model).not.toBe("щедрая");
    const generous = rows.find((r) => r.model === "щедрая")!;
    expect(generous.deviationPctMedian).toBe(100);
    expect(generous.biasPctMean).toBe(100);
    expect(generous.highestCount).toBe(2);
    expect(generous.lowestCount).toBe(0);
  });

  it("консенсус считается без самой модели, иначе она тянет его к себе", () => {
    // Если бы «щедрая» входила в свой же консенсус, медиана трёх была бы 200
    // на первом снимке и отклонение вышло бы нулевым.
    const generous = agreement(calls).find((r) => r.model === "щедрая")!;
    expect(generous.deviationPctMedian).toBeGreaterThan(0);
  });

  it("одинокий снимок без второй модели в согласие не идёт, сбои считаются", () => {
    const lonely = [...calls, call("щедрая", "3.jpg", 500), call("обычная", "4.jpg", 0, { ok: false, failure: "timeout", parsed: undefined })];
    const rows = agreement(lonely);
    expect(rows.find((r) => r.model === "щедрая")!.photos).toBe(2);
    expect(rows.find((r) => r.model === "обычная")!.failureRatePct).toBe(33.3);
  });
});
