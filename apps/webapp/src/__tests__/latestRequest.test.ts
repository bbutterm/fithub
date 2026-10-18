import { describe, expect, it } from "vitest";
import { createLatestRequest } from "../lib/latestRequest";

describe("побеждает последний запрос", () => {
  it("ответ на последний запрос принимается", () => {
    const r = createLatestRequest();
    const isCurrent = r.begin();
    expect(isCurrent()).toBe(true);
  });

  it("ответ на устаревший запрос игнорируется", () => {
    const r = createLatestRequest();
    const first = r.begin();
    const second = r.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("после отмены не принимается ни один ответ в полёте", () => {
    const r = createLatestRequest();
    const inFlight = r.begin();
    r.cancel();
    expect(inFlight()).toBe(false);
  });
});
