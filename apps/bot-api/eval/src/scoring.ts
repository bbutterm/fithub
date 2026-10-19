import type { ModelMetrics } from "./metrics.js";

/**
 * Сводный балл модели: шесть критериев, каждый в понятной шкале 0–100.
 *
 * Балл нужен, чтобы в таблице было видно, кто лучше в целом. Но решение он не
 * принимает: веса выбраны руками, и любая перестановка весов меняет порядок.
 * Поэтому в отчёте всегда показываются все шесть составляющих, а не только
 * итог — иначе получилась бы одна цифра, происхождение которой никто не помнит.
 */

export interface ScoreWeights {
  kcal: number;
  macros: number;
  portion: number;
  reliability: number;
  speed: number;
  price: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  kcal: 0.35,
  macros: 0.2,
  portion: 0.15,
  reliability: 0.15,
  speed: 0.075,
  price: 0.075
};

/** Точки, в которых критерий считается идеальным и полностью проваленным. */
export const SCALE = {
  /** Ошибка по калориям: 0% → 100 баллов, 40% → 0. */
  kcalZeroAt: 40,
  /** Ошибка по БЖУ прощается шире: состав угадать труднее, чем калорийность. */
  macroZeroAt: 60,
  /** Ошибка веса порции. */
  portionZeroAt: 50,
  /** Время ответа: быстрее двух секунд — идеально, двадцать и больше — ноль. */
  speedFastSec: 2,
  speedSlowSec: 20,
  /** Цена за фото. */
  priceCheapUsd: 0.0003,
  priceDearUsd: 0.006
} as const;

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Линейная шкала «меньше — лучше»: при значении good даёт 100, при bad — 0. */
export function lowerIsBetter(value: number, good: number, bad: number): number {
  if (!Number.isFinite(value)) return 0;
  if (bad <= good) return value <= good ? 100 : 0;
  return clamp(((bad - value) / (bad - good)) * 100);
}

export interface ScoreBreakdown {
  /** Калории: главный критерий, ради него всё и затевалось. */
  kcal: number;
  /** Белки, жиры, углеводы. */
  macros: number;
  /** Вес порции: отдельно, потому что ошибка веса и ошибка состава лечатся по-разному. */
  portion: number;
  /** Надёжность: сбои разбора плюс разброс между прогонами. */
  reliability: number;
  speed: number;
  price: number;
  total: number;
}

export function scoreModel(m: ModelMetrics, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoreBreakdown {
  const kcal = lowerIsBetter(m.kcalErrorPctMean, 0, SCALE.kcalZeroAt);
  const macros = lowerIsBetter(m.macroErrorPctMean, 0, SCALE.macroZeroAt);
  const portion = lowerIsBetter(m.gramsErrorPctMean, 0, SCALE.portionZeroAt);
  // Непрочитанный ответ бьёт сильнее нестабильных цифр: при сбое человек не
  // получает вообще ничего, а при разбросе — получает, пусть и менее точное.
  const reliability = clamp(100 - (m.failureRatePct || 0) * 4 - (m.runSpreadPctMean || 0) * 1.5);
  const speed = lowerIsBetter(m.latencySecP95, SCALE.speedFastSec, SCALE.speedSlowSec);
  const price = lowerIsBetter(m.costPerPhotoUsd, SCALE.priceCheapUsd, SCALE.priceDearUsd);

  const sum = weights.kcal + weights.macros + weights.portion + weights.reliability + weights.speed + weights.price;
  const total =
    (kcal * weights.kcal +
      macros * weights.macros +
      portion * weights.portion +
      reliability * weights.reliability +
      speed * weights.speed +
      price * weights.price) /
    (sum || 1);

  return { kcal: r1(kcal), macros: r1(macros), portion: r1(portion), reliability: r1(reliability), speed: r1(speed), price: r1(price), total: r1(total) };
}

export const CRITERIA: Array<{ key: keyof Omit<ScoreBreakdown, "total">; title: string; hint: string }> = [
  { key: "kcal", title: "Калории", hint: "Средняя ошибка по калориям порции" },
  { key: "macros", title: "БЖУ", hint: "Средняя ошибка по белкам, жирам и углеводам" },
  { key: "portion", title: "Вес порции", hint: "Средняя ошибка оценки массы" },
  { key: "reliability", title: "Надёжность", hint: "Сбои разбора и разброс между прогонами" },
  { key: "speed", title: "Скорость", hint: "Время ответа в худших пяти процентах" },
  { key: "price", title: "Цена", hint: "Стоимость одного распознавания" }
];
