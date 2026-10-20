import type { StoredCall } from "./storage.js";

/**
 * Сравнение моделей на снимках, для которых нет эталона.
 *
 * Свои фотографии приходят без взвешивания: человек кидает в папку снимок
 * обеда и хочет увидеть, что скажут модели. Точность тут посчитать не из чего,
 * поэтому считается согласие — насколько ответ модели отличается от того, что
 * сказали остальные.
 *
 * Согласие это не точность. Модели умеют ошибаться хором: на плотной еде со
 * скрытым жиром весь набор занижает калорийность в два-три раза, и консенсус
 * тогда так же неверен, как каждый ответ по отдельности. Эти числа отвечают на
 * вопрос «кто выбивается из общего мнения», а не «кто прав».
 */

const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : NaN);

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Одна оценка на пару «модель-снимок»: повторы усредняются. */
function perPhoto(calls: StoredCall[]): Map<string, Map<string, number>> {
  const acc = new Map<string, Map<string, number[]>>();
  for (const c of calls) {
    if (!c.ok || !c.parsed) continue;
    const byModel = acc.get(c.file) ?? new Map<string, number[]>();
    byModel.set(c.model, [...(byModel.get(c.model) ?? []), c.parsed.kcal]);
    acc.set(c.file, byModel);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [file, byModel] of acc) {
    const avg = new Map<string, number>();
    for (const [model, kcals] of byModel) {
      avg.set(model, kcals.reduce((s, x) => s + x, 0) / kcals.length);
    }
    out.set(file, avg);
  }
  return out;
}

export interface PhotoConsensus {
  file: string;
  /** Медиана оценок всех моделей — то, что считается «общим мнением». */
  consensusKcal: number;
  minKcal: number;
  maxKcal: number;
  /** Во сколько раз самая щедрая оценка больше самой скромной. */
  spreadRatio: number;
  models: number;
  /** Что увидели модели: уникальные названия блюд, по убыванию частоты. */
  dishes: string[];
}

export function photoConsensus(calls: StoredCall[]): PhotoConsensus[] {
  const estimates = perPhoto(calls);
  const dishesByFile = new Map<string, Map<string, number>>();
  for (const c of calls) {
    if (!c.ok || !c.parsed) continue;
    const counts = dishesByFile.get(c.file) ?? new Map<string, number>();
    const label = c.parsed.dishes.join(", ").toLowerCase().trim();
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    dishesByFile.set(c.file, counts);
  }

  return [...estimates.entries()]
    .map(([file, byModel]) => {
      const values = [...byModel.values()];
      const min = Math.min(...values);
      const max = Math.max(...values);
      return {
        file,
        consensusKcal: Math.round(median(values)),
        minKcal: Math.round(min),
        maxKcal: Math.round(max),
        spreadRatio: min > 0 ? r1(max / min) : NaN,
        models: values.length,
        dishes: [...(dishesByFile.get(file) ?? new Map())]
          .sort((a, b) => b[1] - a[1])
          .map(([label]) => label)
      };
    })
    .sort((a, b) => b.spreadRatio - a.spreadRatio);
}

export interface AgreementRow {
  model: string;
  photos: number;
  /** Медиана отклонения от общего мнения, в процентах. */
  deviationPctMedian: number;
  /**
   * Знак отклонения: больше нуля — модель систематически щедрее остальных.
   * Это и есть самое полезное здесь: видно, кто завышает, а кто занижает.
   */
  biasPctMean: number;
  /** Сколько раз модель дала самую высокую и самую низкую оценку на снимке. */
  highestCount: number;
  lowestCount: number;
  failureRatePct: number;
  latencySecMedian: number;
  costPerPhotoUsd: number;
}

export function agreement(calls: StoredCall[]): AgreementRow[] {
  const estimates = perPhoto(calls);
  const models = [...new Set(calls.map((c) => c.model))];

  return models
    .map((model) => {
      const deviations: number[] = [];
      const biases: number[] = [];
      let highest = 0;
      let lowest = 0;
      let photos = 0;

      for (const byModel of estimates.values()) {
        const own = byModel.get(model);
        if (own === undefined || byModel.size < 2) continue;
        photos++;
        // Консенсус считается без самой модели: иначе она тянет к себе
        // общее мнение и выглядит согласнее, чем есть.
        const others = [...byModel.entries()].filter(([m]) => m !== model).map(([, v]) => v);
        const centre = median(others);
        if (centre > 0) {
          deviations.push((Math.abs(own - centre) / centre) * 100);
          biases.push(((own - centre) / centre) * 100);
        }
        const all = [...byModel.values()];
        if (own === Math.max(...all)) highest++;
        if (own === Math.min(...all)) lowest++;
      }

      const own = calls.filter((c) => c.model === model);
      const failed = own.filter((c) => !c.ok).length;
      const latencies = own.filter((c) => c.ok).map((c) => c.latencyMs / 1000);
      const files = new Set(own.map((c) => c.file)).size;
      const cost = own.reduce((s, c) => s + c.costUsd, 0);

      return {
        model,
        photos,
        deviationPctMedian: r1(median(deviations)),
        biasPctMean: r1(biases.reduce((s, x) => s + x, 0) / (biases.length || 1)),
        highestCount: highest,
        lowestCount: lowest,
        failureRatePct: own.length ? r1((failed / own.length) * 100) : 0,
        latencySecMedian: r1(median(latencies)),
        costPerPhotoUsd: files ? Number((cost / files).toFixed(5)) : 0
      };
    })
    .sort((a, b) => a.deviationPctMedian - b.deviationPctMedian);
}
