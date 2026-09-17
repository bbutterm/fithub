import { describe, expect, it } from "vitest";
import { buildDietContext, DIET_PRESETS, getDietPreset, normalizeDiets } from "../diets.js";
import { buildDietCheckRequest } from "../prompts/diet.js";

describe("normalizeDiets", () => {
  it("отбрасывает неизвестные идентификаторы", () => {
    expect(normalizeDiets(["table5", "нет-такого", ""])).toEqual(["table5"]);
  });

  it("убирает дубли и держит порядок справочника", () => {
    const order = DIET_PRESETS.map((d) => d.id);
    const shuffled = [...order].reverse();
    expect(normalizeDiets([...shuffled, ...shuffled])).toEqual(order);
  });

  it("пустой список остаётся пустым", () => {
    expect(normalizeDiets([])).toEqual([]);
  });
});

describe("buildDietContext", () => {
  it("без режимов, заметок и аллергий возвращает null — вызывать модель незачем", () => {
    expect(buildDietContext({ diets: [], notes: null, allergies: [] })).toBeNull();
    expect(buildDietContext({ diets: ["неизвестный"], notes: "   ", allergies: [] })).toBeNull();
  });

  it("подставляет правила режима, а не его название", () => {
    const ctx = buildDietContext({ diets: ["table5"], allergies: [] });
    expect(ctx).not.toBeNull();
    expect(ctx!.labels).toEqual(["Стол №5"]);
    // В промпт должны уйти конкретные запреты, иначе модель отвечает по памяти
    expect(ctx!.rulesText).toContain("ЗАПРЕЩЕНО");
    expect(ctx!.rulesText).toContain(getDietPreset("table5")!.rules);
  });

  it("сочетает несколько режимов", () => {
    const ctx = buildDietContext({ diets: ["mediterranean", "table5"], allergies: [] });
    expect(ctx!.labels).toEqual(["Стол №5", "Средиземноморская"]);
    expect(ctx!.rulesText).toContain("Стол №5");
    expect(ctx!.rulesText).toContain("Средиземноморская");
  });

  it("аллергии попадают в контекст как строгий запрет", () => {
    const ctx = buildDietContext({ diets: [], allergies: ["арахис"] });
    expect(ctx!.rulesText).toContain("строгий запрет");
    expect(ctx!.rulesText).toContain("арахис");
  });

  it("одни только свои ограничения тоже включают проверку", () => {
    const ctx = buildDietContext({ diets: [], notes: "без острого", allergies: [] });
    expect(ctx!.rulesText).toContain("без острого");
    // Подпись нужна всегда: карточке нечего было бы показать
    expect(ctx!.labels.length).toBeGreaterThan(0);
  });

  it("пустые аллергии не считаются ограничением", () => {
    expect(buildDietContext({ diets: [], allergies: ["", "  "] })).toBeNull();
  });
});

describe("buildDietCheckRequest", () => {
  it("кладёт правила и блюда в один запрос", () => {
    const text = buildDietCheckRequest({ dishes: ["жареный картофель — 250 г"], rulesText: "ЗАПРЕЩЕНО: жареное." });
    expect(text).toContain("ЗАПРЕЩЕНО: жареное.");
    expect(text).toContain("- жареный картофель — 250 г");
  });
});

describe("справочник", () => {
  it("у каждого режима есть подпись, пояснение и непустые правила", () => {
    for (const d of DIET_PRESETS) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(0);
      expect(d.rules.length).toBeGreaterThan(50);
    }
  });

  it("идентификаторы уникальны", () => {
    const ids = DIET_PRESETS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
