import { describe, expect, it } from "vitest";
import { suggestRecipeName } from "../services/recipes.js";

const item = (dish: string, kcal: number) => ({ dish, grams: 100, kcal, protein: 0, fat: 0, carbs: 0 });

describe("suggestRecipeName", () => {
  it("одна позиция — её название", () => {
    expect(suggestRecipeName([item("Овсянка на молоке", 300)])).toBe("Овсянка на молоке");
  });

  it("несколько позиций — две самые калорийные через запятую", () => {
    // Порядок в списке не важен: имя строится по вкладу в калории
    const name = suggestRecipeName([item("Огурец", 10), item("Куриная грудка", 250), item("Рис", 180)]);
    expect(name).toBe("Куриная грудка, Рис");
  });

  it("имя начинается с заглавной буквы", () => {
    // Распознавание возвращает названия с маленькой: «куриная грудка, рис отварной»
    expect(suggestRecipeName([item("куриная грудка", 300), item("рис отварной", 200)])).toBe(
      "Куриная грудка, рис отварной"
    );
  });

  it("пустой состав не роняет и даёт запасное имя", () => {
    expect(suggestRecipeName([])).toBe("Блюдо");
  });

  it("пустые названия не превращаются в имя", () => {
    expect(suggestRecipeName([{ ...item("   ", 100) }])).toBe("Блюдо");
  });

  it("длинное имя обрезается до 60 символов", () => {
    const long = suggestRecipeName([item("А".repeat(80), 100)]);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });
});
