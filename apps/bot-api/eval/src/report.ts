import { escape } from "node:querystring";
import type { ModelMetrics, Truth, CallRecord } from "./metrics.js";
import { byTag, comparisonIsMeaningful, failedThresholds, worstMisses, type Thresholds } from "./metrics.js";
import type { StoredCall } from "./storage.js";

/** Сводная таблица раздела 4: строка на модель, колонка на метрику. */
export function metricsTable(rows: ModelMetrics[], baseline: string): string {
  const num = (v: number, suffix = "") => (Number.isFinite(v) ? `${v}${suffix}` : "—");
  const head = "| Модель | Ошибка ккал | Медиана | p90 | Знак | Вес порции | Б, г | Ж, г | У, г | Разброс | Сбои | p95 ответа | $/фото |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = [...rows]
    .sort((a, b) => (a.kcalErrorPctMean || Infinity) - (b.kcalErrorPctMean || Infinity))
    .map((m) => {
      const name = m.model === baseline ? `${m.model} (текущая)` : m.model;
      const bias = Number.isFinite(m.kcalBiasPctMean) ? `${m.kcalBiasPctMean > 0 ? "+" : ""}${m.kcalBiasPctMean}%` : "—";
      return `| ${name} | ${num(m.kcalErrorPctMean, "%")} | ${num(m.kcalErrorPctMedian, "%")} | ${num(m.kcalErrorPctP90, "%")} | ${bias} | ${num(m.gramsErrorPctMean, "%")} | ${num(m.proteinErrorGMean)} | ${num(m.fatErrorGMean)} | ${num(m.carbsErrorGMean)} | ${num(m.runSpreadPctMean, "%")} | ${num(m.failureRatePct, "%")} | ${num(m.latencySecP95, " с")} | ${m.costPerPhotoUsd} |`;
    });
  return [head, sep, ...body].join("\n");
}

/** Таблица ручной разметки названий, если она уже сделана. */
export function dishTable(rows: ModelMetrics[]): string | null {
  const marked = rows.filter((m) => m.dishCorrectPct !== undefined);
  if (marked.length === 0) return null;
  const head = "| Модель | Верно | Близко | Мимо |";
  const sep = "|---|---|---|---|";
  const body = marked
    .sort((a, b) => (b.dishCorrectPct ?? 0) - (a.dishCorrectPct ?? 0))
    .map((m) => `| ${m.model} | ${m.dishCorrectPct}% | ${m.dishClosePct}% | ${m.dishMissPct}% |`);
  return [head, sep, ...body].join("\n");
}

export interface ReportInput {
  rows: ModelMetrics[];
  calls: CallRecord[];
  stored: StoredCall[];
  truths: Truth[];
  thresholds: Thresholds;
  baseline: string;
  totalCostUsd: number;
  photosDir: string;
  holdout: boolean;
}

/** Отчёт в markdown: таблицы, отсев по порогам, проверка на шум, худшие промахи. */
export function markdownReport(input: ReportInput): string {
  const { rows, thresholds, baseline } = input;
  const lines: string[] = [];
  lines.push(`# Прогон eval${input.holdout ? " (отложенные фото)" : ""}`);
  lines.push("");
  lines.push(`Фото: ${input.truths.length} · моделей: ${rows.length} · вызовов: ${input.calls.length} · потрачено: $${input.totalCostUsd.toFixed(4)}`);
  lines.push("");
  lines.push("## Метрики");
  lines.push("");
  lines.push(metricsTable(rows, baseline));

  const dishes = dishTable(rows);
  if (dishes) {
    lines.push("");
    lines.push("## Названия блюд (ручная разметка вслепую)");
    lines.push("");
    lines.push(dishes);
  }

  lines.push("");
  lines.push("## Отсев по порогам");
  lines.push("");
  const passed: ModelMetrics[] = [];
  for (const m of rows) {
    const failed = failedThresholds(m, thresholds);
    if (failed.length === 0) {
      passed.push(m);
      lines.push(`- **${m.model}** — проходит`);
    } else {
      lines.push(`- ~~${m.model}~~ — ${failed.join("; ")}`);
    }
  }

  if (passed.length >= 2) {
    const sorted = [...passed].sort((a, b) => a.kcalErrorPctMean - b.kcalErrorPctMean);
    const check = comparisonIsMeaningful(sorted[0]!, sorted[1]!);
    lines.push("");
    lines.push("## Разница против шума");
    lines.push("");
    lines.push(
      check.meaningful
        ? `Разрыв между «${sorted[0]!.model}» и «${sorted[1]!.model}» — ${check.gap} п.п. при разбросе между прогонами ${check.noise} п.п. Разница больше шума, выбирать можно.`
        : `Разрыв между «${sorted[0]!.model}» и «${sorted[1]!.model}» всего ${check.gap} п.п. при разбросе между прогонами ${check.noise} п.п. Это шум: нужен больший набор или больше прогонов.`
    );
  }

  lines.push("");
  lines.push("## По типам блюд, ошибка по ккал");
  lines.push("");
  const tags = [...new Set(input.truths.flatMap((t) => t.tags))];
  if (tags.length) {
    lines.push(`| Модель | ${tags.join(" | ")} |`);
    lines.push(`|---|${tags.map(() => "---").join("|")}|`);
    for (const m of rows) {
      const per = byTag(m.model, input.calls, input.truths);
      lines.push(`| ${m.model} | ${tags.map((t) => (Number.isFinite(per[t]!) ? `${per[t]}%` : "—")).join(" | ")} |`);
    }
  }

  lines.push("");
  lines.push("## Худшие промахи (смотреть глазами)");
  for (const m of rows) {
    const misses = worstMisses(m.model, input.calls, input.truths, 5);
    if (misses.length === 0) continue;
    lines.push("");
    lines.push(`### ${m.model}`);
    lines.push("");
    lines.push("| Фото | Эталон, ккал | Ответ, ккал | Ошибка | Что ответила модель |");
    lines.push("|---|---|---|---|---|");
    for (const miss of misses) {
      const stored = input.stored.find(
        (s) => s.model === miss.call.model && s.file === miss.call.file && s.run === miss.call.run
      );
      const dishes = stored?.parsed?.dishes?.join(", ") ?? "—";
      lines.push(
        `| ${miss.truth.file} | ${Math.round(miss.truth.kcal)} | ${Math.round(miss.call.kcal ?? 0)} | ${Math.round(miss.errorPct)}% | ${dishes} |`
      );
    }
  }

  lines.push("");
  lines.push("## Решение");
  lines.push("");
  lines.push("<!-- Заполняется руками: какую модель ставим, её точность, цена, главная слабость и что из этого следует для бота. -->");
  lines.push("");
  return lines.join("\n");
}

/** HTML с фотографиями промахов: разбирать причины удобнее, когда снимок перед глазами. */
export function htmlReport(input: ReportInput, markdown: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const blocks: string[] = [];
  for (const m of input.rows) {
    const misses = worstMisses(m.model, input.calls, input.truths, 5);
    if (misses.length === 0) continue;
    const cards = misses
      .map((miss) => {
        const stored = input.stored.find(
          (s) => s.model === miss.call.model && s.file === miss.call.file && s.run === miss.call.run
        );
        const src = `${input.photosDir}/${escape(miss.truth.file)}`;
        return `<figure>
  <img src="${esc(src)}" alt="${esc(miss.truth.file)}" loading="lazy">
  <figcaption>
    <b>${esc(miss.truth.file)}</b><br>
    эталон ${Math.round(miss.truth.kcal)} ккал · ответ ${Math.round(miss.call.kcal ?? 0)} ккал · ошибка ${Math.round(miss.errorPct)}%<br>
    блюда: ${esc(stored?.parsed?.dishes?.join(", ") ?? "—")}
  </figcaption>
  <details><summary>сырой ответ</summary><pre>${esc(stored?.raw ?? "")}</pre></details>
</figure>`;
      })
      .join("\n");
    blocks.push(`<h2>${esc(m.model)}</h2>\n<div class="grid">${cards}</div>`);
  }

  return `<!doctype html>
<meta charset="utf-8">
<title>Промахи моделей</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; max-width: 1100px; color: #1d2420; background: #f7f9f5 }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px }
  figure { margin: 0; background: #fff; border: 1px solid #d2d9cf; padding: 10px }
  img { width: 100%; height: 200px; object-fit: cover }
  figcaption { font-size: 13px; margin-top: 8px }
  pre { white-space: pre-wrap; font-size: 11px; background: #eef1ec; padding: 8px; overflow-x: auto }
  table { border-collapse: collapse; font-size: 13px } td, th { border: 1px solid #d2d9cf; padding: 4px 8px }
</style>
<h1>Промахи моделей</h1>
<p>Фото открываются из папки набора. Рядом — сырой ответ модели целиком.</p>
${blocks.join("\n")}
<h2>Отчёт</h2>
<pre>${esc(markdown)}</pre>
`;
}
