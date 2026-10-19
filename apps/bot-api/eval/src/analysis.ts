import type { Truth } from "./metrics.js";
import type { StoredCall } from "./storage.js";

/**
 * Разборы, которые считаются по уже оплаченным вызовам.
 *
 * Прогон стоит денег, а эти вопросы — нет: ответы на них лежат в тех же
 * сохранённых строках. Все функции чистые, поэтому их видно в тестах, а не
 * только в отчёте.
 */

const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : NaN);
const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : NaN);
const errPct = (pred: number, truth: number) => (truth > 0 ? (Math.abs(pred - truth) / truth) * 100 : NaN);

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface Pred { file: string; kcal: number; grams: number; confidence?: number; run: number }

function predictions(model: string, calls: StoredCall[]): Pred[] {
  return calls
    .filter((c) => c.model === model && c.ok && c.parsed)
    .map((c) => ({ file: c.file, kcal: c.parsed!.kcal, grams: c.parsed!.grams, confidence: c.parsed!.confidence, run: c.run }));
}

/** Среднее по прогонам для каждого фото: одна оценка на снимок. */
function perPhoto(preds: Pred[]): Map<string, { kcal: number; grams: number; confidence: number }> {
  const byFile = new Map<string, Pred[]>();
  for (const p of preds) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  const out = new Map<string, { kcal: number; grams: number; confidence: number }>();
  for (const [file, list] of byFile) {
    out.set(file, {
      kcal: mean(list.map((p) => p.kcal)),
      grams: mean(list.map((p) => p.grams)),
      confidence: mean(list.map((p) => p.confidence ?? 1))
    });
  }
  return out;
}

export interface ErrorSplit {
  model: string;
  /** Обычная ошибка по калориям. */
  totalPct: number;
  /** Ошибка оценки массы порции. */
  weightPct: number;
  /** Что осталось бы, если бы вес угадывался идеально: ошибка состава. */
  compositionPct: number;
  /** Какая доля общей ошибки объясняется весом. */
  weightSharePct: number;
}

/**
 * Откуда берётся ошибка: из веса порции или из состава.
 *
 * Калорийность примерно линейна по массе, поэтому ответ модели можно
 * пересчитать на правильный вес. Что останется — это ошибка в том, чем модель
 * считает еду на тарелке. Разделение важно: ошибку веса лечат вопросом «сколько
 * граммов», ошибку состава — только другой моделью или промптом.
 */
export function splitError(model: string, calls: StoredCall[], truths: Truth[]): ErrorSplit {
  const byFile = perPhoto(predictions(model, calls));
  const total: number[] = [];
  const weight: number[] = [];
  const composition: number[] = [];
  for (const t of truths) {
    const p = byFile.get(t.file);
    if (!p || !(t.kcal > 0)) continue;
    total.push(errPct(p.kcal, t.kcal));
    if (p.grams > 0 && t.grams > 0) {
      weight.push(errPct(p.grams, t.grams));
      composition.push(errPct(p.kcal * (t.grams / p.grams), t.kcal));
    }
  }
  const totalPct = mean(total);
  const compositionPct = mean(composition);
  return {
    model,
    totalPct: r1(totalPct),
    weightPct: r1(mean(weight)),
    compositionPct: r1(compositionPct),
    weightSharePct: r1(totalPct > 0 ? Math.max(0, ((totalPct - compositionPct) / totalPct) * 100) : NaN)
  };
}

export interface Calibration {
  model: string;
  /** Постоянный множитель, выравнивающий систематический сдвиг. */
  factor: number;
  before: number;
  after: number;
}

/**
 * Поправочный коэффициент.
 *
 * Если модель стабильно завышает на треть, её ответ можно умножать на
 * константу прямо в боте. Берём медиану отношений «эталон к ответу»: она не
 * уезжает от одного дикого промаха, в отличие от среднего.
 */
export function calibrate(model: string, calls: StoredCall[], truths: Truth[]): Calibration {
  const byFile = perPhoto(predictions(model, calls));
  const ratios: number[] = [];
  const before: number[] = [];
  for (const t of truths) {
    const p = byFile.get(t.file);
    if (!p || !(t.kcal > 0) || !(p.kcal > 0)) continue;
    ratios.push(t.kcal / p.kcal);
    before.push(errPct(p.kcal, t.kcal));
  }
  const factor = median(ratios);
  const after = truths
    .map((t) => {
      const p = byFile.get(t.file);
      return p && t.kcal > 0 ? errPct(p.kcal * factor, t.kcal) : NaN;
    })
    .filter(Number.isFinite);
  return { model, factor: r3(factor), before: r1(mean(before)), after: r1(mean(after)) };
}

export interface RunsBenefit {
  model: string;
  single: number;
  medianOfRuns: number;
  runs: number;
}

/** Стоит ли платить за три прогона: сравнение одного ответа с медианой нескольких. */
export function runsBenefit(model: string, calls: StoredCall[], truths: Truth[]): RunsBenefit {
  const preds = predictions(model, calls);
  const runs = new Set(preds.map((p) => p.run)).size;
  const byFile = new Map<string, Pred[]>();
  for (const p of preds) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);

  const single: number[] = [];
  const combined: number[] = [];
  for (const t of truths) {
    const list = byFile.get(t.file);
    if (!list?.length || !(t.kcal > 0)) continue;
    const first = list.find((p) => p.run === 1) ?? list[0]!;
    single.push(errPct(first.kcal, t.kcal));
    combined.push(errPct(median(list.map((p) => p.kcal)), t.kcal));
  }
  return { model, single: r1(mean(single)), medianOfRuns: r1(mean(combined)), runs };
}

export interface PairResult {
  models: [string, string];
  pairPct: number;
  bestSinglePct: number;
  /** Насколько пара лучше лучшего из двух, в пунктах. */
  gainPct: number;
  costUsd: number;
}

/**
 * Ансамбль из двух моделей: среднее их ответов по каждому фото.
 *
 * Два дешёвых ответа иногда точнее одного дорогого, и это видно без новых
 * вызовов. Цена пары — сумма цен обеих, поэтому выигрыш сравнивается с ней.
 */
export function bestPairs(models: string[], calls: StoredCall[], truths: Truth[], limit = 5): PairResult[] {
  const byModel = new Map(models.map((m) => [m, perPhoto(predictions(m, calls))]));
  const errorOf = (get: (file: string) => number | null) => {
    const errs: number[] = [];
    for (const t of truths) {
      const v = get(t.file);
      if (v !== null && Number.isFinite(v) && t.kcal > 0) errs.push(errPct(v, t.kcal));
    }
    return mean(errs);
  };
  const costOf = (m: string) => {
    const mine = calls.filter((c) => c.model === m);
    const files = new Set(mine.map((c) => c.file)).size || 1;
    return mine.reduce((s, c) => s + c.costUsd, 0) / files;
  };
  const singles = new Map(models.map((m) => [m, errorOf((f) => byModel.get(m)!.get(f)?.kcal ?? null)]));

  const out: PairResult[] = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i]!;
      const b = models[j]!;
      const pair = errorOf((f) => {
        const x = byModel.get(a)!.get(f)?.kcal;
        const y = byModel.get(b)!.get(f)?.kcal;
        return x !== undefined && y !== undefined ? (x + y) / 2 : null;
      });
      const bestSingle = Math.min(singles.get(a)!, singles.get(b)!);
      out.push({
        models: [a, b],
        pairPct: r1(pair),
        bestSinglePct: r1(bestSingle),
        gainPct: r1(bestSingle - pair),
        costUsd: Number((costOf(a) + costOf(b)).toFixed(5))
      });
    }
  }
  return out.sort((x, y) => x.pairPct - y.pairPct).slice(0, limit);
}

export interface ConfidenceSignal {
  model: string;
  threshold: number;
  /** Доля ответов, где модель сама не уверена. */
  belowPct: number;
  errorBelow: number;
  errorAbove: number;
  /** Работает ли самооценка: ошибка у неуверенных ответов заметно выше. */
  useful: boolean;
}

/**
 * Честна ли модель про свою уверенность.
 *
 * Бот переспрашивает дорогой моделью, когда уверенность ниже порога. Если у
 * неуверенных ответов ошибка такая же, как у уверенных, этот переспрос — просто
 * удвоение счёта.
 */
export function confidenceSignal(model: string, calls: StoredCall[], truths: Truth[], threshold = 0.7): ConfidenceSignal {
  const byFile = new Map(truths.map((t) => [t.file, t]));
  const below: number[] = [];
  const above: number[] = [];
  for (const p of predictions(model, calls)) {
    const t = byFile.get(p.file);
    if (!t || !(t.kcal > 0)) continue;
    const e = errPct(p.kcal, t.kcal);
    if (!Number.isFinite(e)) continue;
    ((p.confidence ?? 1) < threshold ? below : above).push(e);
  }
  const total = below.length + above.length;
  const errorBelow = r1(mean(below));
  const errorAbove = r1(mean(above));
  return {
    model,
    threshold,
    belowPct: r1(total ? (below.length / total) * 100 : NaN),
    errorBelow,
    errorAbove,
    useful: Number.isFinite(errorBelow) && Number.isFinite(errorAbove) && errorBelow > errorAbove * 1.3
  };
}
