import { describe, expect, it } from "vitest";
import { detectCheckIntent } from "../bot/checkIntent.js";

describe("detectCheckIntent", () => {
  it("обычная подпись — не проверка", () => {
    expect(detectCheckIntent("борщ со сметаной").check).toBe(false);
    expect(detectCheckIntent("").check).toBe(false);
    expect(detectCheckIntent(undefined).check).toBe(false);
  });

  it("явное слово — сильный сигнал", () => {
    const r = detectCheckIntent("можно мне это?");
    expect(r).toMatchObject({ check: true, strong: true, hint: null });
    expect(detectCheckIntent("проверь").strong).toBe(true);
    expect(detectCheckIntent("а если пиццу").strong).toBe(true);
  });

  it("один знак вопроса — слабый сигнал", () => {
    expect(detectCheckIntent("там точно 300 грамм?")).toMatchObject({ check: true, strong: false });
  });

  it("подсказка — блюдо без служебных слов", () => {
    expect(detectCheckIntent("можно мне жареную картошку?").hint).toBe("жареную картошку");
    expect(detectCheckIntent("Подходит ли мне тирамису").hint).toBe("тирамису");
  });

  it("не ловит слова внутри других слов", () => {
    expect(detectCheckIntent("невозможное пирожное").check).toBe(false);
  });
});
