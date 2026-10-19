/**
 * Метрики раздела 4: считает код, не модель-судья.
 *
 * Все функции здесь чистые — их можно проверить тестами, и именно они решают,
 * какая модель победит. Названия блюд размечаются вручную и вслепую; код
 * только собирает отметки в проценты.
 */

export interface CallRecord {
  model: string;
  file: string;
  run: number;
  /** Ответ разобран и пригоден к сравнению. */
  ok: boolean;
  /** Почему не ok: bad_json | refusal | empty | http | network | timeout. */
  failure?: string;
  grams?: number;
  kcal?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
  latencyMs: number;
  costUsd: number;
  /** Сетевых повторов до успеха — считаются отдельно от ошибок модели. */
  networkRetries: number;
}

export interface Truth {
  file: string;
  grams: number;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  tags: string[];
}

export type Verdict = "верно" | "близко" | "мимо";

const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : NaN);

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Перцентиль методом ближайшего ранга: на наборе в полсотни фото интерполяция создаёт ложную точность. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))]!;
}

export interface ModelMetrics {
  model: string;
  photos: number;
  calls: number;
  /** Доля вызовов, где ответ не удалось разобрать или модель отказалась. */
  failureRatePct: number;
  /** Сетевые сбои — не вина модели, поэтому отдельной строкой. */
  networkRetries: number;

  kcalErrorPctMean: number;
  kcalErrorPctMedian: number;
  kcalErrorPctP90: number;
  kcalErrorAbsMean: number;
  /** Знак ошибки: больше нуля — модель завышает калорийность. */
  kcalBiasPctMean: number;

  gramsErrorPctMean: number;
  /** Ошибка по белкам, жирам и углеводам в процентах от эталона — для сводного балла. */
  macroErrorPctMean: number;
  proteinErrorGMean: number;
  fatErrorGMean: number;
  carbsErrorGMean: number;

  /** Разброс калорий между прогонами одного фото, в процентах от эталона. */
  runSpreadPctMean: number;
  /** Сколько прогонов сделано по этой модели: в одной таблице их может быть разное число. */
  runs: number;

  latencySecMean: number;
  latencySecP95: number;
  costPerPhotoUsd: number;

  /** Доли ручных отметок, если разметка названий уже сделана. */
  dishCorrectPct?: number;
  dishClosePct?: number;
  dishMissPct?: number;
}

const errPct = (pred: number, truth: number) => (truth > 0 ? (Math.abs(pred - truth) / truth) * 100 : NaN);
const biasPct = (pred: number, truth: number) => (truth > 0 ? ((pred - truth) / truth) * 100 : NaN);
const defined = (v: number[]) => v.filter((x) => Number.isFinite(x));

/**
 * Сводка по модели.
 *
 * Сначала усредняем прогоны внутри фото, потом считаем по фото. Если смешать
 * всё в одну кучу, фото с тремя удачными ответами весит втрое больше, чем фото,
 * на котором модель дважды сломалась.
 */
export function summarize(
  model: string,
  calls: CallRecord[],
  truths: Truth[],
  verdicts: Map<string, Verdict> = new Map()
): ModelMetrics {
  const mine = calls.filter((c) => c.model === model);
  const runIds = new Set(mine.map((c) => c.run));
  const perPhoto = {
    kcalErr: [] as number[], kcalAbs: [] as number[], bias: [] as number[],
    grams: [] as number[], protein: [] as number[], fat: [] as number[], carbs: [] as number[],
    macroPct: [] as number[], spread: [] as number[]
  };

  for (const t of truths) {
    const ok = mine.filter((c) => c.file === t.file && c.ok);
    if (ok.length === 0) continue;
    const kcals = ok.map((c) => c.kcal ?? NaN).filter(Number.isFinite);
    if (kcals.length) {
      perPhoto.kcalErr.push(mean(kcals.map((k) => errPct(k, t.kcal))));
      perPhoto.kcalAbs.push(mean(kcals.map((k) => Math.abs(k - t.kcal))));
      perPhoto.bias.push(mean(kcals.map((k) => biasPct(k, t.kcal))));
      if (kcals.length > 1 && t.kcal > 0) {
        perPhoto.spread.push(((Math.max(...kcals) - Math.min(...kcals)) / t.kcal) * 100);
      }
    }
    const pick = (f: (c: CallRecord) => number | undefined) => defined(ok.map((c) => f(c) ?? NaN));
    const g = pick((c) => c.grams);
    if (g.length) perPhoto.grams.push(mean(g.map((v) => errPct(v, t.grams))));
    const p = pick((c) => c.protein);
    if (p.length) perPhoto.protein.push(mean(p.map((v) => Math.abs(v - t.protein))));
    const f = pick((c) => c.fat);
    if (f.length) perPhoto.fat.push(mean(f.map((v) => Math.abs(v - t.fat))));
    const cb = pick((c) => c.carbs);
    if (cb.length) perPhoto.carbs.push(mean(cb.map((v) => Math.abs(v - t.carbs))));

    // Относительная ошибка по макросам. Нутриент меньше трёх граммов пропускаем:
    // ошибиться на грамм при эталоне в два — это 50%, хотя для тарелки это ничто.
    const rel: number[] = [];
    for (const [got, want] of [[p, t.protein], [f, t.fat], [cb, t.carbs]] as const) {
      if (got.length && want >= 3) rel.push(mean(got.map((v) => errPct(v, want))));
    }
    if (rel.length) perPhoto.macroPct.push(mean(rel));
  }

  const failures = mine.filter((c) => !c.ok).length;
  const marks = mine.map((c) => verdicts.get(`${c.model}|${c.file}|${c.run}`)).filter(Boolean) as Verdict[];
  const share = (v: Verdict) => (marks.length ? r1((marks.filter((m) => m === v).length / marks.length) * 100) : undefined);

  return {
    model,
    photos: truths.length,
    calls: mine.length,
    failureRatePct: mine.length ? r1((failures / mine.length) * 100) : NaN,
    networkRetries: mine.reduce((s, c) => s + c.networkRetries, 0),

    kcalErrorPctMean: r1(mean(perPhoto.kcalErr)),
    kcalErrorPctMedian: r1(median(perPhoto.kcalErr)),
    kcalErrorPctP90: r1(percentile(perPhoto.kcalErr, 90)),
    kcalErrorAbsMean: r1(mean(perPhoto.kcalAbs)),
    kcalBiasPctMean: r1(mean(perPhoto.bias)),

    gramsErrorPctMean: r1(mean(perPhoto.grams)),
    macroErrorPctMean: r1(mean(perPhoto.macroPct)),
    proteinErrorGMean: r1(mean(perPhoto.protein)),
    fatErrorGMean: r1(mean(perPhoto.fat)),
    carbsErrorGMean: r1(mean(perPhoto.carbs)),

    runSpreadPctMean: r1(mean(perPhoto.spread)),
    runs: runIds.size,

    latencySecMean: r1(mean(mine.map((c) => c.latencyMs)) / 1000),
    latencySecP95: r1(percentile(mine.map((c) => c.latencyMs), 95) / 1000),
    costPerPhotoUsd: Number((mean(mine.map((c) => c.costUsd)) || 0).toFixed(5)),

    dishCorrectPct: share("верно"),
    dishClosePct: share("близко"),
    dishMissPct: share("мимо")
  };
}

export interface Thresholds {
  kcalErrorPctMean: number;
  costPerPhotoUsd: number;
  latencySecP95: number;
  failureRatePct: number;
}

/** Какие пороги раздела 1 модель не прошла. Пустой список — прошла все. */
export function failedThresholds(m: ModelMetrics, t: Thresholds): string[] {
  const out: string[] = [];
  if (Number.isFinite(m.kcalErrorPctMean) && m.kcalErrorPctMean > t.kcalErrorPctMean) {
    out.push(`ошибка по ккал ${m.kcalErrorPctMean}% > ${t.kcalErrorPctMean}%`);
  }
  if (m.costPerPhotoUsd > t.costPerPhotoUsd) out.push(`цена ${m.costPerPhotoUsd}$ > ${t.costPerPhotoUsd}$ за фото`);
  if (Number.isFinite(m.latencySecP95) && m.latencySecP95 > t.latencySecP95) {
    out.push(`время ${m.latencySecP95} с > ${t.latencySecP95} с`);
  }
  if (Number.isFinite(m.failureRatePct) && m.failureRatePct > t.failureRatePct) {
    out.push(`сбоев ${m.failureRatePct}% > ${t.failureRatePct}%`);
  }
  return out;
}

/**
 * Разница между финалистами против разброса между прогонами.
 *
 * Пункт из раздела 5: если лидеры отличаются слабее, чем модель отличается
 * сама от себя, выбирать по этим цифрам нельзя.
 */
export function comparisonIsMeaningful(a: ModelMetrics, b: ModelMetrics): { meaningful: boolean; gap: number; noise: number } {
  const gap = Math.abs(a.kcalErrorPctMean - b.kcalErrorPctMean);
  const noise = Math.max(a.runSpreadPctMean || 0, b.runSpreadPctMean || 0);
  return { meaningful: gap > noise, gap: r1(gap), noise: r1(noise) };
}

/** Самые большие промахи модели — их смотрят глазами (раздел 5). */
export function worstMisses(model: string, calls: CallRecord[], truths: Truth[], limit = 5) {
  const byFile = new Map(truths.map((t) => [t.file, t]));
  return calls
    .filter((c) => c.model === model && c.ok && c.kcal !== undefined)
    .map((c) => {
      const t = byFile.get(c.file);
      return t ? { call: c, truth: t, errorPct: errPct(c.kcal!, t.kcal) } : null;
    })
    .filter((x): x is { call: CallRecord; truth: Truth; errorPct: number } => x !== null && Number.isFinite(x.errorPct))
    .sort((a, b) => b.errorPct - a.errorPct)
    .slice(0, limit);
}

/** Разбивка по типам блюд: простые, смешанные, со скрытыми калориями. */
export function byTag(model: string, calls: CallRecord[], truths: Truth[]): Record<string, number> {
  const out: Record<string, number> = {};
  const tags = [...new Set(truths.flatMap((t) => t.tags))];
  for (const tag of tags) {
    const subset = truths.filter((t) => t.tags.includes(tag));
    out[tag] = summarize(model, calls, subset).kcalErrorPctMean;
  }
  return out;
}

export interface PhotoRow {
  file: string;
  tags: string[];
  truthKcal: number;
  truthGrams: number;
  /** Среднее по прогонам; null, если ни один прогон не разобрался. */
  gotKcal: number | null;
  gotGrams: number | null;
  errorPct: number | null;
  /** Разброс калорий между прогонами в процентах от эталона. */
  spreadPct: number | null;
  dishes: string[];
  failures: number;
  runs: number;
  latencySec: number;
  costUsd: number;
}

/**
 * Построчно по фотографиям: то, во что проваливаются из общей таблицы.
 *
 * Средние по модели отвечают на вопрос «кто лучше», а этот список — на вопрос
 * «почему»: видно, какие именно тарелки модель не понимает.
 */
export function perPhotoRows(
  model: string,
  calls: CallRecord[],
  truths: Truth[],
  dishesOf: (file: string, run: number) => string[] = () => []
): PhotoRow[] {
  const rows: PhotoRow[] = [];
  for (const t of truths) {
    const mine = calls.filter((c) => c.model === model && c.file === t.file);
    if (mine.length === 0) continue;
    const ok = mine.filter((c) => c.ok);
    const kcals = ok.map((c) => c.kcal ?? NaN).filter(Number.isFinite);
    const gramsList = ok.map((c) => c.grams ?? NaN).filter(Number.isFinite);
    const gotKcal = kcals.length ? mean(kcals) : null;
    rows.push({
      file: t.file,
      tags: t.tags,
      truthKcal: t.kcal,
      truthGrams: t.grams,
      gotKcal: gotKcal === null ? null : Math.round(gotKcal),
      gotGrams: gramsList.length ? Math.round(mean(gramsList)) : null,
      errorPct: gotKcal === null ? null : r1(errPct(gotKcal, t.kcal)),
      spreadPct: kcals.length > 1 && t.kcal > 0 ? r1(((Math.max(...kcals) - Math.min(...kcals)) / t.kcal) * 100) : null,
      dishes: ok.length ? dishesOf(t.file, ok[0]!.run) : [],
      failures: mine.length - ok.length,
      runs: mine.length,
      latencySec: r1(mean(mine.map((c) => c.latencyMs)) / 1000),
      costUsd: Number(mine.reduce((s, c) => s + c.costUsd, 0).toFixed(5))
    });
  }
  return rows.sort((a, b) => (b.errorPct ?? -1) - (a.errorPct ?? -1));
}
