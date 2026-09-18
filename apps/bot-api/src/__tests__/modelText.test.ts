import { describe, expect, it } from "vitest";
import { toTelegramHtml } from "../utils/modelText.js";

describe("toTelegramHtml", () => {
  it("парные звёздочки становятся жирным", () => {
    expect(toTelegramHtml("📊 **Динамика** за месяц")).toBe("📊 <b>Динамика</b> за месяц");
  });

  it("непарная звёздочка остаётся как есть", () => {
    expect(toTelegramHtml("5 * 3 = 15")).toBe("5 * 3 = 15");
    expect(toTelegramHtml("**незакрытый")).toBe("**незакрытый");
  });

  it("markdown-заголовок становится жирной строкой", () => {
    expect(toTelegramHtml("### Итоги\nтекст")).toBe("<b>Итоги</b>\nтекст");
  });

  it("экранирует HTML, иначе Telegram отклонит сообщение", () => {
    expect(toTelegramHtml("белок <100 г & жиры >80")).toBe("белок &lt;100 г &amp; жиры &gt;80");
  });

  it("экранирование не ломает жирный", () => {
    expect(toTelegramHtml("**a<b**")).toBe("<b>a&lt;b</b>");
  });

  it("несколько выделений в одной строке", () => {
    expect(toTelegramHtml("**раз** и **два**")).toBe("<b>раз</b> и <b>два</b>");
  });
});
