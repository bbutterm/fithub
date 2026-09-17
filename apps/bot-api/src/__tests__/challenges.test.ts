import { describe, expect, it } from "vitest";
import {
  assessFeasibility,
  CHALLENGE_TEMPLATES,
  describeRule,
  evaluateDay,
  getTemplate,
  withValue,
  type ChallengeRule,
  type DayFacts
} from "../challenges.js";

const day = (o: Partial<DayFacts> = {}): DayFacts => ({
  kcal: 1800,
  protein: 110,
  fat: 60,
  carbs: 200,
  mealsCount: 3,
  firstMealHour: 9,
  ...o
});

describe("evaluateDay", () => {
  it("день без записей — пропуск, а не провал", () => {
    // Иначе бот наказывает за то, что им не пользовались, и люди боятся пропускать записи
    const rule: ChallengeRule = { type: "threshold", metric: "protein", value: 100 };
    expect(evaluateDay(rule, day({ mealsCount: 0, protein: 0 }))).toBe("skip");
  });

  it("порог: не ниже значения", () => {
    const rule: ChallengeRule = { type: "threshold", metric: "protein", value: 100 };
    expect(evaluateDay(rule, day({ protein: 100 }))).toBe("pass");
    expect(evaluateDay(rule, day({ protein: 99.9 }))).toBe("fail");
  });

  it("потолок: не выше значения", () => {
    const rule: ChallengeRule = { type: "limit", metric: "kcal", value: 1800 };
    expect(evaluateDay(rule, day({ kcal: 1800 }))).toBe("pass");
    expect(evaluateDay(rule, day({ kcal: 1801 }))).toBe("fail");
  });

  it("число приёмов пищи", () => {
    const rule: ChallengeRule = { type: "count", value: 3 };
    expect(evaluateDay(rule, day({ mealsCount: 3 }))).toBe("pass");
    expect(evaluateDay(rule, day({ mealsCount: 2 }))).toBe("fail");
  });

  it("привычка: первый приём строго раньше часа", () => {
    const rule: ChallengeRule = { type: "habit", what: "meal_before", hour: 10 };
    expect(evaluateDay(rule, day({ firstMealHour: 9 }))).toBe("pass");
    expect(evaluateDay(rule, day({ firstMealHour: 10 }))).toBe("fail");
  });

  it("запрет без вердикта модели не выдумывает результат", () => {
    const rule: ChallengeRule = { type: "avoid", judge: "сладкое" };
    expect(evaluateDay(rule, day())).toBe("skip");
    expect(evaluateDay(rule, day(), true)).toBe("pass");
    expect(evaluateDay(rule, day(), false)).toBe("fail");
  });
});

describe("assessFeasibility", () => {
  const profile = { weightKg: 80, gender: "male" as const, targetKcal: 2000 };

  it("отказывает в челлендже длиннее 60 дней", () => {
    const r = assessFeasibility({ rule: { type: "count", value: 3 }, days: 90, history: [], profile });
    expect(r.verdict).toBe("refuse");
  });

  it("отказывает в калорийности ниже физиологического пола", () => {
    const r = assessFeasibility({ rule: { type: "limit", metric: "kcal", value: 900 }, days: 14, history: [], profile });
    expect(r.verdict).toBe("refuse");
    expect(r.reason).toContain("1500");
  });

  it("порог для женщин ниже, чем для мужчин", () => {
    const rule: ChallengeRule = { type: "limit", metric: "kcal", value: 1300 };
    const female = { weightKg: 60, gender: "female" as const, targetKcal: 1600 };
    expect(assessFeasibility({ rule, days: 14, history: [], profile: female }).verdict).not.toBe("refuse");
    expect(assessFeasibility({ rule, days: 14, history: [], profile }).verdict).toBe("refuse");
  });

  it("отказывает в белке выше 2.5 г на кг и предлагает разумную планку", () => {
    const r = assessFeasibility({ rule: { type: "threshold", metric: "protein", value: 250 }, days: 14, history: [], profile });
    expect(r.verdict).toBe("refuse");
    expect(r.suggestedValue).toBe(160); // 80 кг × 2
  });

  it("мало записей — не берётся судить", () => {
    const r = assessFeasibility({
      rule: { type: "threshold", metric: "protein", value: 130 },
      days: 10,
      history: [day(), day({ mealsCount: 0 })],
      profile
    });
    expect(r.verdict).toBe("ok");
    expect(r.loggedDays).toBe(1);
  });

  it("считает выполнимость по собственной истории и предлагает свою планку", () => {
    // 14 дней, белок 90..103: цель 130 не бралась ни разу
    const history = Array.from({ length: 14 }, (_, i) => day({ protein: 90 + i }));
    const r = assessFeasibility({ rule: { type: "threshold", metric: "protein", value: 130 }, days: 10, history, profile });
    expect(r.verdict).toBe("risky");
    expect(r.metDays).toBe(0);
    expect(r.loggedDays).toBe(14);
    expect(r.suggestedValue).toBeDefined();
    // Предложенная планка должна быть достижимой: не выше того, что человек реально брал
    expect(r.suggestedValue!).toBeLessThan(130);
  });

  it("посильную планку пропускает", () => {
    const history = Array.from({ length: 14 }, () => day({ protein: 140 }));
    const r = assessFeasibility({ rule: { type: "threshold", metric: "protein", value: 130 }, days: 10, history, profile });
    expect(r.verdict).toBe("ok");
    expect(r.metDays).toBe(14);
  });

  it("дни без записей не идут в знаменатель", () => {
    const history = [...Array.from({ length: 5 }, () => day({ protein: 140 })), ...Array.from({ length: 9 }, () => day({ mealsCount: 0 }))];
    const r = assessFeasibility({ rule: { type: "threshold", metric: "protein", value: 130 }, days: 10, history, profile });
    expect(r.loggedDays).toBe(5);
    expect(r.verdict).toBe("ok");
  });
});

describe("шаблоны и описания", () => {
  it("у каждого шаблона уникальный id, срок и описываемое правило", () => {
    const ids = CHALLENGE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of CHALLENGE_TEMPLATES) {
      expect(t.days).toBeGreaterThan(0);
      expect(t.days).toBeLessThanOrEqual(60);
      expect(describeRule(t.rule).length).toBeGreaterThan(5);
      expect(getTemplate(t.id)).toEqual(t);
    }
  });

  it("withValue меняет планку и не трогает правила без неё", () => {
    expect(withValue({ type: "threshold", metric: "protein", value: 100 }, 120)).toEqual({
      type: "threshold",
      metric: "protein",
      value: 120
    });
    const avoid: ChallengeRule = { type: "avoid", judge: "сладкое" };
    expect(withValue(avoid, 5)).toEqual(avoid);
  });
});
