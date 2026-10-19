import { describe, expect, it } from "vitest";
import { dedupeCalls, doneKeys, isInfrastructureFailure } from "../src/storage.js";
import type { StoredCall } from "../src/storage.js";

const call = (over: Partial<StoredCall>): StoredCall => ({
  model: "m", file: "001.jpg", run: 1, at: "", ok: true,
  latencyMs: 1000, costUsd: 0.001, promptTokens: 1, completionTokens: 1,
  networkRetries: 0, raw: "{}", ...over
});

describe("isInfrastructureFailure", () => {
  it("кончившиеся кредиты, лимит запросов и сеть — сбой площадки", () => {
    expect(isInfrastructureFailure(call({ ok: false, failure: "http", httpStatus: 402 }))).toBe(true);
    expect(isInfrastructureFailure(call({ ok: false, failure: "http", httpStatus: 429 }))).toBe(true);
    expect(isInfrastructureFailure(call({ ok: false, failure: "http", httpStatus: 503 }))).toBe(true);
    expect(isInfrastructureFailure(call({ ok: false, failure: "network" }))).toBe(true);
  });

  it("кривой JSON, отказ и таймаут — свойства модели, их прячем не надо", () => {
    expect(isInfrastructureFailure(call({ ok: false, failure: "bad_json" }))).toBe(false);
    expect(isInfrastructureFailure(call({ ok: false, failure: "refusal" }))).toBe(false);
    expect(isInfrastructureFailure(call({ ok: false, failure: "timeout" }))).toBe(false);
    expect(isInfrastructureFailure(call({ ok: false, failure: "http", httpStatus: 400 }))).toBe(false);
    expect(isInfrastructureFailure(call({ ok: true }))).toBe(false);
  });
});

describe("doneKeys", () => {
  it("удачный вызов и ответ модели со сбоем повторять не нужно", () => {
    const keys = doneKeys([call({}), call({ file: "002.jpg", ok: false, failure: "bad_json" })]);
    expect(keys.has("m|001.jpg|1")).toBe(true);
    expect(keys.has("m|002.jpg|1")).toBe(true);
  });

  it("сбой площадки не считается сделанным — перезапуск его доберёт", () => {
    const keys = doneKeys([call({ ok: false, failure: "http", httpStatus: 402 })]);
    expect(keys.has("m|001.jpg|1")).toBe(false);
  });

  it("после добора ключ снова считается сделанным", () => {
    const keys = doneKeys([call({ ok: false, failure: "http", httpStatus: 402 }), call({})]);
    expect(keys.has("m|001.jpg|1")).toBe(true);
  });
});

describe("dedupeCalls", () => {
  it("оставляет последнюю запись на тройку и не трогает остальные", () => {
    const rows = dedupeCalls([
      call({ ok: false, failure: "http", httpStatus: 402, costUsd: 0 }),
      call({ costUsd: 0.004 }),
      call({ file: "002.jpg", costUsd: 0.002 })
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.file === "001.jpg")!.costUsd).toBe(0.004);
  });
});
