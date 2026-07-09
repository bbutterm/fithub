import { describe, expect, it } from "vitest";
import { addDays, localDateStr, localTimeStr, zonedDayRangeUtc, zonedTimeToUtc } from "../utils/tz.js";

describe("tz utils", () => {
  const now = new Date("2026-07-09T21:30:00Z");

  it("localDateStr учитывает таймзону", () => {
    expect(localDateStr("Europe/Moscow", now)).toBe("2026-07-10"); // 00:30 следующего дня по Москве
    expect(localDateStr("UTC", now)).toBe("2026-07-09");
  });

  it("localTimeStr в HH:MM", () => {
    expect(localTimeStr("Europe/Moscow", now)).toBe("00:30");
  });

  it("zonedTimeToUtc: московская полночь = 21:00 UTC предыдущего дня", () => {
    const utc = zonedTimeToUtc("2026-07-10", "00:00", "Europe/Moscow");
    expect(utc.toISOString()).toBe("2026-07-09T21:00:00.000Z");
  });

  it("zonedDayRangeUtc покрывает ровно 24 часа", () => {
    const { start, end } = zonedDayRangeUtc("2026-07-10", "Europe/Moscow");
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it("addDays переваливает через месяц", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
