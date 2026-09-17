import type { DayStat } from "./services/stats.js";

/**
 * Правило челленджа.
 *
 * Хранится как JSON, а не раскладывается по колонкам: типов правил будет больше,
 * и добавление нового не должно требовать миграции. Вся логика — в чистой
 * функции evaluateDay, которую можно проверить тестами без базы и без сети.
 *
 * Главное ограничение, которое здесь зашито: правило должно проверяться по
 * данным, которые бот собирает сам. Челлендж, требующий самоотчёта («10 000
 * шагов»), умирает за неделю — человек перестаёт ставить галочки.
 */
export type ChallengeRule =
  | { type: "threshold"; metric: Metric; value: number } // метрика не ниже значения
  | { type: "limit"; metric: Metric; value: number } // метрика не выше значения
  | { type: "count"; value: number } // не меньше N приёмов пищи за день
  | { type: "habit"; what: "meal_before"; hour: number } // успеть поесть до часа X
  | { type: "avoid"; judge: string }; // запрет, который проверяет текстовая модель

export type Metric = "kcal" | "protein" | "fat" | "carbs";

const METRIC_LABEL: Record<Metric, string> = {
  kcal: "калории",
  protein: "белок",
  fat: "жиры",
  carbs: "углеводы"
};
const METRIC_UNIT: Record<Metric, string> = { kcal: "ккал", protein: "г", fat: "г", carbs: "г" };

export type DayStatus = "pass" | "fail" | "skip";

export interface DayFacts {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  mealsCount: number;
  /** Час самого раннего приёма пищи в локальном времени; null — записей нет. */
  firstMealHour: number | null;
}

export function factsFromStat(stat: DayStat, firstMealHour: number | null): DayFacts {
  return {
    kcal: stat.kcal,
    protein: stat.protein,
    fat: stat.fat,
    carbs: stat.carbs,
    mealsCount: stat.mealsCount,
    firstMealHour
  };
}

/**
 * Итог дня по правилу.
 *
 * День без единой записи — это «skip», а не «fail». Иначе бот наказывает за то,
 * что человек им не пользовался, и люди начинают бояться пропускать записи —
 * а это ломает основной продукт. Пропуск не засчитывается, но и не обнуляет.
 *
 * Правило avoid здесь не решается: его проверяет текстовая модель по названиям
 * блюд, и вызывающий передаёт готовый вердикт через avoidVerdict.
 */
export function evaluateDay(rule: ChallengeRule, facts: DayFacts, avoidVerdict?: boolean): DayStatus {
  if (facts.mealsCount === 0) return "skip";

  switch (rule.type) {
    case "threshold":
      return facts[rule.metric] >= rule.value ? "pass" : "fail";
    case "limit":
      return facts[rule.metric] <= rule.value ? "pass" : "fail";
    case "count":
      return facts.mealsCount >= rule.value ? "pass" : "fail";
    case "habit":
      return facts.firstMealHour !== null && facts.firstMealHour < rule.hour ? "pass" : "fail";
    case "avoid":
      // Нет вердикта модели — не выдумываем: считаем день пропущенным
      return avoidVerdict === undefined ? "skip" : avoidVerdict ? "pass" : "fail";
  }
}

/** Человеческое описание правила — для карточки челленджа и подтверждения. */
export function describeRule(rule: ChallengeRule): string {
  switch (rule.type) {
    case "threshold":
      return `${METRIC_LABEL[rule.metric]} не меньше ${rule.value} ${METRIC_UNIT[rule.metric]} в день`;
    case "limit":
      return `${METRIC_LABEL[rule.metric]} не больше ${rule.value} ${METRIC_UNIT[rule.metric]} в день`;
    case "count":
      return `не меньше ${rule.value} приёмов пищи в день`;
    case "habit":
      return `первый приём пищи до ${String(rule.hour).padStart(2, "0")}:00`;
    case "avoid":
      return `без «${rule.judge}»`;
  }
}

/** Что показать в вечерней сводке: факт дня рядом с целью. */
export function describeDayFacts(rule: ChallengeRule, facts: DayFacts): string {
  switch (rule.type) {
    case "threshold":
    case "limit":
      return `${Math.round(facts[rule.metric])} ${METRIC_UNIT[rule.metric]}`;
    case "count":
      return `${facts.mealsCount} приёмов`;
    case "habit":
      return facts.firstMealHour === null
        ? "записей нет"
        : `первый приём в ${String(facts.firstMealHour).padStart(2, "0")}:00`;
    case "avoid":
      return "по составу дня";
  }
}

export interface ChallengeTemplate {
  id: string;
  title: string;
  hint: string;
  days: number;
  rule: ChallengeRule;
}

/**
 * Готовые челленджи.
 *
 * Пустой экран «создайте свой» не работает почти ни у кого: свой челлендж — для
 * тех, кто уже прошёл готовый.
 */
export const CHALLENGE_TEMPLATES: ChallengeTemplate[] = [
  { id: "protein7", title: "Белок 7 дней", hint: "держать белок на уровне цели", days: 7, rule: { type: "threshold", metric: "protein", value: 100 } },
  { id: "deficit14", title: "Дефицит 14 дней", hint: "не выходить за калории", days: 14, rule: { type: "limit", metric: "kcal", value: 1800 } },
  { id: "breakfast21", title: "Завтрак до 10:00", hint: "21 день без пропущенного завтрака", days: 21, rule: { type: "habit", what: "meal_before", hour: 10 } },
  { id: "meals3", title: "Три приёма в день", hint: "10 дней без перекусов вместо еды", days: 10, rule: { type: "count", value: 3 } },
  { id: "nosugar14", title: "Без сладкого", hint: "14 дней без десертов и сладостей", days: 14, rule: { type: "avoid", judge: "сладкое, десерты, конфеты, выпечка, сладкие напитки" } },
  { id: "nofastfood10", title: "Без фастфуда", hint: "10 дней без бургеров и жареного навынос", days: 10, rule: { type: "avoid", judge: "фастфуд, бургеры, картофель фри, шаурма, пицца навынос" } }
];

export function getTemplate(id: string): ChallengeTemplate | undefined {
  return CHALLENGE_TEMPLATES.find((t) => t.id === id);
}

// --- Выполнимость ---

export interface FeasibilityInput {
  rule: ChallengeRule;
  days: number;
  /** Дни за последние две недели: нужны факты, а не ощущения. */
  history: DayFacts[];
  profile: { weightKg: number | null; gender: "male" | "female" | null; targetKcal: number | null } | null;
}

export interface Feasibility {
  verdict: "ok" | "risky" | "refuse";
  /** Одно предложение пользователю. Пусто — говорить нечего. */
  reason: string;
  /** Планка, которую человек берёт в большинстве дней. */
  suggestedValue?: number;
  /** Сколько дней из истории правило выполнялось. */
  metDays?: number;
  loggedDays?: number;
}

/** Физиологический пол калорийности: ниже этого челлендж не создаём вовсе. */
function kcalFloor(gender: "male" | "female" | null): number {
  return gender === "male" ? 1500 : 1200;
}

/** Планка, которую человек берёт примерно в двух третях дней. */
function achievable(values: number[], direction: "atLeast" | "atMost"): number | undefined {
  if (values.length < 3) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  // atLeast: берём нижнюю треть — такую планку человек перешагивает в 2/3 дней.
  // atMost: верхнюю треть — в 2/3 дней он ниже неё.
  const idx = direction === "atLeast" ? Math.floor(sorted.length / 3) : Math.ceil((sorted.length * 2) / 3) - 1;
  const v = sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
  return v === undefined ? undefined : Math.round(v / 5) * 5;
}

/**
 * Насколько челлендж по силам этому человеку.
 *
 * Работает по его собственным записям, а не по абстрактной норме: «за 14 дней ты
 * набирал 130 г белка дважды» человек игнорирует куда реже, чем «рекомендуется
 * 1.6 г на кг». Это же единственная защита от невыполнимого челленджа —
 * провал выгоняет не из челленджа, а из бота.
 */
export function assessFeasibility(input: FeasibilityInput): Feasibility {
  const { rule, days, history, profile } = input;

  if (days > 60) {
    return { verdict: "refuse", reason: "Челленджи длиннее 60 дней не работают: до конца не доходит почти никто." };
  }

  if (rule.type === "limit" && rule.metric === "kcal") {
    const floor = kcalFloor(profile?.gender ?? null);
    if (rule.value < floor) {
      return {
        verdict: "refuse",
        reason: `Ниже ${floor} ккал в день я челлендж не поставлю — это уже не дефицит, а голодание.`
      };
    }
  }

  if (rule.type === "threshold" && rule.metric === "protein" && profile?.weightKg) {
    const perKg = rule.value / profile.weightKg;
    if (perKg > 2.5) {
      const sane = Math.round((profile.weightKg * 2) / 5) * 5;
      return {
        verdict: "refuse",
        reason: `${rule.value} г белка — это больше 2.5 г на кг вашего веса. Столько не нужно даже на сушке; разумный потолок — около ${sane} г.`,
        suggestedValue: sane
      };
    }
  }

  const logged = history.filter((d) => d.mealsCount > 0);
  if (logged.length < 3) {
    return {
      verdict: "ok",
      reason: "Записей пока мало, так что сравнить не с чем — посмотрим по ходу.",
      loggedDays: logged.length
    };
  }

  const metDays = logged.filter((d) => evaluateDay(rule, d, true) === "pass").length;
  const share = metDays / logged.length;

  // avoid проверяется моделью, по истории его не посчитать
  if (rule.type === "avoid") {
    return { verdict: "ok", reason: "", loggedDays: logged.length };
  }

  if (share >= 0.5) {
    return {
      verdict: "ok",
      reason: `По вашим записям это выполнялось ${metDays} раз из ${logged.length} — планка посильная.`,
      metDays,
      loggedDays: logged.length
    };
  }

  const suggestedValue =
    rule.type === "threshold"
      ? achievable(logged.map((d) => d[rule.metric]), "atLeast")
      : rule.type === "limit"
        ? achievable(logged.map((d) => d[rule.metric]), "atMost")
        : undefined;

  return {
    verdict: "risky",
    reason:
      `За последние ${logged.length} дней с записями это выполнялось ${metDays} раз. ` +
      (suggestedValue !== undefined
        ? `Челлендж почти наверняка сорвётся — предлагаю ${suggestedValue}.`
        : "Челлендж почти наверняка сорвётся."),
    suggestedValue,
    metDays,
    loggedDays: logged.length
  };
}

/** Подставить предложенную планку в правило. */
export function withValue(rule: ChallengeRule, value: number): ChallengeRule {
  if (rule.type === "threshold" || rule.type === "limit") return { ...rule, value };
  if (rule.type === "count") return { ...rule, value };
  return rule;
}
