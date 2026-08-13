import { describe, expect, it } from "vitest";
import { chunk, shouldSendMonthly } from "../cron/schedule.js";

describe("shouldSendMonthly — окно доставки месячного отчёта", () => {
  it("1-го числа шлём после 9 утра", () => {
    expect(shouldSendMonthly("2026-09-01", 8)).toBe(false);
    expect(shouldSendMonthly("2026-09-01", 9)).toBe(true);
    expect(shouldSendMonthly("2026-09-01", 23)).toBe(true);
  });

  it("2-го числа окно ещё открыто — на случай, если 1-го тик не застал пользователя", () => {
    expect(shouldSendMonthly("2026-09-02", 11)).toBe(true);
    expect(shouldSendMonthly("2026-09-02", 3)).toBe(false);
  });

  it("3-го числа шлём в любой час: лучше отчёт в неудобное время, чем никакого", () => {
    // Это и чинит западные таймзоны: при суточном кроне в 08:00 UTC у зоны UTC−8
    // локальный час всегда 00:00, и условие «после 9 утра» не наступало бы никогда
    expect(shouldSendMonthly("2026-09-03", 0)).toBe(true);
    expect(shouldSendMonthly("2026-09-03", 22)).toBe(true);
  });

  it("после 3-го числа отчёт за прошлый месяц уже не шлём", () => {
    expect(shouldSendMonthly("2026-09-04", 12)).toBe(false);
    expect(shouldSendMonthly("2026-09-17", 12)).toBe(false);
    expect(shouldSendMonthly("2026-09-30", 12)).toBe(false);
  });

  it("не спотыкается о мусор во входной дате", () => {
    expect(shouldSendMonthly("", 12)).toBe(false);
    expect(shouldSendMonthly("2026-09-xx", 12)).toBe(false);
  });
});

describe("chunk — пачки для параллельной рассылки", () => {
  it("разбивает по размеру, последняя пачка неполная", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("пустой список даёт пустой результат", () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it("пачка больше списка — один кусок", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("нулевой размер запрещён — иначе бесконечный цикл", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});
