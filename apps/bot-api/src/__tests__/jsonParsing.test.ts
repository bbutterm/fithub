import { describe, expect, it } from "vitest";
import { stripJsonFences } from "../lib/ai.js";

describe("stripJsonFences", () => {
  const json = '{"items":[],"error":"no_food"}';

  it("возвращает чистый JSON как есть", () => {
    expect(stripJsonFences(json)).toBe(json);
  });

  it("срезает ```json фенсы", () => {
    expect(stripJsonFences("```json\n" + json + "\n```")).toBe(json);
    expect(stripJsonFences("```\n" + json + "\n```")).toBe(json);
  });

  it("вырезает JSON из окружающего текста", () => {
    expect(stripJsonFences("Вот результат: " + json + " Готово!")).toBe(json);
  });

  it("вложенные скобки не ломают вырезание", () => {
    const nested = '{"a":{"b":[1,2,{"c":3}]}}';
    expect(JSON.parse(stripJsonFences("prefix " + nested))).toEqual({ a: { b: [1, 2, { c: 3 }] } });
  });
});
