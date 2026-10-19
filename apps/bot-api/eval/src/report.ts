import type { CallRecord, ModelMetrics, Truth } from "./metrics.js";
import { byTag, comparisonIsMeaningful, failedThresholds, perPhotoRows, worstMisses, type Thresholds } from "./metrics.js";
import { CRITERIA, DEFAULT_WEIGHTS, scoreModel, type ScoreBreakdown, type ScoreWeights } from "./scoring.js";
import type { StoredCall } from "./storage.js";

export interface ReportInput {
  rows: ModelMetrics[];
  calls: CallRecord[];
  stored: StoredCall[];
  truths: Truth[];
  thresholds: Thresholds;
  weights?: ScoreWeights;
  baseline: string;
  totalCostUsd: number;
  photosDir: string;
  holdout: boolean;
}

const num = (v: number, suffix = "") => (Number.isFinite(v) ? `${v}${suffix}` : "—");

function scored(input: ReportInput): Array<{ m: ModelMetrics; s: ScoreBreakdown }> {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  return input.rows
    .map((m) => ({ m, s: scoreModel(m, weights) }))
    .sort((a, b) => b.s.total - a.s.total);
}

/** Сводная таблица: балл по каждому критерию плюс сырые числа за ним. */
export function metricsTable(input: ReportInput): string {
  const head =
    "| Модель | Балл | Калории | БЖУ | Вес | Надёжность | Скорость | Цена | ошибка ккал | ошибка БЖУ | ошибка веса | сбои | p95 | $/фото |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = scored(input).map(({ m, s }) => {
    const name = m.model === input.baseline ? `${m.model} (текущая)` : m.model;
    return `| ${name} | **${s.total}** | ${s.kcal} | ${s.macros} | ${s.portion} | ${s.reliability} | ${s.speed} | ${s.price} | ${num(m.kcalErrorPctMean, "%")} | ${num(m.macroErrorPctMean, "%")} | ${num(m.gramsErrorPctMean, "%")} | ${num(m.failureRatePct, "%")} | ${num(m.latencySecP95, " с")} | ${m.costPerPhotoUsd} |`;
  });
  return [head, sep, ...body].join("\n");
}

export function dishTable(rows: ModelMetrics[]): string | null {
  const marked = rows.filter((m) => m.dishCorrectPct !== undefined);
  if (marked.length === 0) return null;
  const body = marked
    .sort((a, b) => (b.dishCorrectPct ?? 0) - (a.dishCorrectPct ?? 0))
    .map((m) => `| ${m.model} | ${m.dishCorrectPct}% | ${m.dishClosePct}% | ${m.dishMissPct}% |`);
  return ["| Модель | Верно | Близко | Мимо |", "|---|---|---|---|", ...body].join("\n");
}

export function markdownReport(input: ReportInput): string {
  const lines: string[] = [];
  const order = scored(input);
  lines.push(`# Прогон eval${input.holdout ? " (отложенные фото)" : ""}`);
  lines.push("");
  lines.push(`Фото: ${input.truths.length} · моделей: ${input.rows.length} · вызовов: ${input.calls.length} · потрачено: $${input.totalCostUsd.toFixed(4)}`);
  lines.push("");
  lines.push("## Сводная таблица");
  lines.push("");
  lines.push(metricsTable(input));
  lines.push("");
  lines.push("Балл — взвешенная сумма шести критериев, каждый в шкале 0–100. Веса выбраны руками, поэтому рядом всегда стоят исходные числа.");

  const dishes = dishTable(input.rows);
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
  for (const { m } of order) {
    const failed = failedThresholds(m, input.thresholds);
    if (failed.length === 0) { passed.push(m); lines.push(`- **${m.model}** — проходит`); }
    else lines.push(`- ~~${m.model}~~ — ${failed.join("; ")}`);
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

  const tags = [...new Set(input.truths.flatMap((t) => t.tags))];
  if (tags.length) {
    lines.push("");
    lines.push("## По типам блюд, ошибка по ккал");
    lines.push("");
    lines.push(`| Модель | ${tags.join(" | ")} |`);
    lines.push(`|---|${tags.map(() => "---").join("|")}|`);
    for (const { m } of order) {
      const per = byTag(m.model, input.calls, input.truths);
      lines.push(`| ${m.model} | ${tags.map((t) => (Number.isFinite(per[t]!) ? `${per[t]}%` : "—")).join(" | ")} |`);
    }
  }

  lines.push("");
  lines.push("## Худшие промахи");
  for (const { m } of order) {
    const misses = worstMisses(m.model, input.calls, input.truths, 5);
    if (misses.length === 0) continue;
    lines.push("");
    lines.push(`### ${m.model}`);
    lines.push("");
    lines.push("| Фото | Эталон, ккал | Ответ, ккал | Ошибка |");
    lines.push("|---|---|---|---|");
    for (const miss of misses) {
      lines.push(`| ${miss.truth.file} | ${Math.round(miss.truth.kcal)} | ${Math.round(miss.call.kcal ?? 0)} | ${Math.round(miss.errorPct)}% |`);
    }
  }

  lines.push("");
  lines.push("## Решение");
  lines.push("");
  lines.push("<!-- Какую модель ставим, её точность, цена, главная слабость и что из этого следует для бота. -->");
  lines.push("");
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

function bar(value: number): string {
  const hue = Math.round((value / 100) * 120); // красный → зелёный
  // Заливка приглушена, число поверх неё обычного цвета: на сплошной зелёной
  // полосе белая цифра не читалась ни в светлой теме, ни в тёмной.
  return `<span class="bar"><i style="width:${Math.max(2, value)}%;background:hsl(${hue} 60% 45%)"></i><b>${value}</b></span>`;
}

/**
 * Страница сравнения: сверху все модели рядом, ниже — отдельный разбор каждой.
 *
 * Один файл без зависимостей: открывается двойным кликом, фотографии берутся
 * из папки набора по относительному пути.
 */
export function htmlReport(input: ReportInput): string {
  const order = scored(input);
  const tags = [...new Set(input.truths.flatMap((t) => t.tags))];
  const dishesOf = (model: string) => (file: string, run: number) =>
    input.stored.find((s) => s.model === model && s.file === file && s.run === run)?.parsed?.dishes ?? [];

  const overviewRows = order
    .map(({ m, s }, i) => {
      const name = m.model === input.baseline ? `${esc(m.model)} <em>текущая</em>` : esc(m.model);
      const failed = failedThresholds(m, input.thresholds);
      return `<tr>
  <td class="rank">${i + 1}</td>
  <td><a href="#m-${slug(m.model)}" class="model" data-model="${slug(m.model)}">${name}</a>
      ${failed.length ? `<div class="fail">не проходит: ${esc(failed.join("; "))}</div>` : `<div class="pass">проходит пороги</div>`}</td>
  <td class="total">${bar(s.total)}</td>
  ${CRITERIA.map((c) => `<td>${bar(s[c.key])}</td>`).join("")}
  <td class="raw">${num(m.kcalErrorPctMean, "%")}</td>
  <td class="raw">${num(m.gramsErrorPctMean, "%")}</td>
  <td class="raw">${num(m.failureRatePct, "%")}</td>
  <td class="raw">${num(m.latencySecP95, " с")}</td>
  <td class="raw">$${m.costPerPhotoUsd}</td>
</tr>`;
    })
    .join("\n");

  const sections = order
    .map(({ m, s }) => {
      const rows = perPhotoRows(m.model, input.calls, input.truths, dishesOf(m.model));
      const per = byTag(m.model, input.calls, input.truths);
      const misses = worstMisses(m.model, input.calls, input.truths, 5);
      const failures = input.stored.filter((c) => c.model === m.model && !c.ok);

      const cards = misses
        .map((miss) => {
          const raw = input.stored.find((c) => c.model === m.model && c.file === miss.call.file && c.run === miss.call.run);
          return `<figure>
  <img src="${esc(input.photosDir)}/${esc(miss.truth.file)}" alt="${esc(miss.truth.file)}" loading="lazy">
  <figcaption><b>${esc(miss.truth.file)}</b><br>эталон ${Math.round(miss.truth.kcal)} ккал · ответ ${Math.round(miss.call.kcal ?? 0)} · ошибка ${Math.round(miss.errorPct)}%<br>${esc((raw?.parsed?.dishes ?? []).join(", ") || "—")}</figcaption>
  <details><summary>сырой ответ</summary><pre>${esc(raw?.raw ?? "")}</pre></details>
</figure>`;
        })
        .join("");

      const photoRows = rows
        .map(
          (r) => `<tr class="${r.errorPct !== null && r.errorPct > 40 ? "bad" : ""}">
  <td><a href="${esc(input.photosDir)}/${esc(r.file)}" target="_blank">${esc(r.file)}</a></td>
  <td>${esc(r.tags.join(", "))}</td>
  <td>${Math.round(r.truthKcal)}</td>
  <td>${r.gotKcal ?? "—"}</td>
  <td>${r.errorPct === null ? "—" : `${r.errorPct}%`}</td>
  <td>${Math.round(r.truthGrams)}</td>
  <td>${r.gotGrams ?? "—"}</td>
  <td>${r.spreadPct === null ? "—" : `${r.spreadPct}%`}</td>
  <td>${r.failures ? `${r.failures} из ${r.runs}` : "—"}</td>
  <td>${r.latencySec} с</td>
  <td>${esc(r.dishes.join(", "))}</td>
</tr>`
        )
        .join("");

      return `<section class="model-page" id="m-${slug(m.model)}" data-model="${slug(m.model)}" hidden>
  <h2>${esc(m.model)} <span class="score">${s.total}</span></h2>

  <div class="criteria">
    ${CRITERIA.map((c) => `<div class="crit"><div class="t">${c.title}</div>${bar(s[c.key])}<div class="h">${c.hint}</div></div>`).join("")}
  </div>

  <div class="facts">
    <div><span>Ошибка по калориям</span><b>${num(m.kcalErrorPctMean, "%")}</b><i>медиана ${num(m.kcalErrorPctMedian, "%")}, худшие 10% — ${num(m.kcalErrorPctP90, "%")}</i></div>
    <div><span>Знак ошибки</span><b>${Number.isFinite(m.kcalBiasPctMean) ? `${m.kcalBiasPctMean > 0 ? "+" : ""}${m.kcalBiasPctMean}%` : "—"}</b><i>${m.kcalBiasPctMean > 0 ? "завышает" : "занижает"} калорийность</i></div>
    <div><span>Вес порции</span><b>${num(m.gramsErrorPctMean, "%")}</b><i>ошибка массы отдельно от состава</i></div>
    <div><span>БЖУ</span><b>${num(m.macroErrorPctMean, "%")}</b><i>Б ${num(m.proteinErrorGMean)} г · Ж ${num(m.fatErrorGMean)} г · У ${num(m.carbsErrorGMean)} г</i></div>
    <div><span>Сбои</span><b>${num(m.failureRatePct, "%")}</b><i>${failures.length} из ${m.calls} вызовов, сетевых повторов ${m.networkRetries}</i></div>
    <div><span>Разброс прогонов</span><b>${num(m.runSpreadPctMean, "%")}</b><i>между повторами одного фото</i></div>
    <div><span>Время</span><b>${num(m.latencySecP95, " с")}</b><i>в среднем ${num(m.latencySecMean, " с")}</i></div>
    <div><span>Цена</span><b>$${m.costPerPhotoUsd}</b><i>за одно распознавание</i></div>
  </div>

  ${tags.length ? `<h3>По типам блюд</h3><table class="tags"><tr>${tags.map((t) => `<th>${esc(t)}</th>`).join("")}</tr><tr>${tags.map((t) => `<td>${Number.isFinite(per[t]!) ? `${per[t]}%` : "—"}</td>`).join("")}</tr></table>` : ""}

  ${cards ? `<h3>Худшие промахи</h3><div class="grid">${cards}</div>` : ""}

  <h3>Все фотографии</h3>
  <table class="photos">
    <thead><tr><th>Фото</th><th>Тип</th><th>Ккал эталон</th><th>Ккал ответ</th><th>Ошибка</th><th>Вес эталон</th><th>Вес ответ</th><th>Разброс</th><th>Сбои</th><th>Время</th><th>Что увидела модель</th></tr></thead>
    <tbody>${photoRows}</tbody>
  </table>

  ${failures.length ? `<h3>Сбои</h3><table class="photos"><thead><tr><th>Фото</th><th>Прогон</th><th>Причина</th><th>Ответ</th></tr></thead><tbody>${failures
    .map((f) => `<tr><td>${esc(f.file)}</td><td>${f.run}</td><td>${esc(f.failure ?? "")}${f.httpStatus ? ` (${f.httpStatus})` : ""}</td><td><pre>${esc(f.raw.slice(0, 400))}</pre></td></tr>`)
    .join("")}</tbody></table>` : ""}
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<meta charset="utf-8">
<title>Сравнение моделей${input.holdout ? " (отложенные)" : ""}</title>
<style>
  :root { --bg:#f4f6f2; --card:#fff; --ink:#1d2420; --soft:#5a655c; --line:#d6ddd2; --accent:#3d6246 }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141917; --card:#1b211d; --ink:#e7ede7; --soft:#a8b3a9; --line:#2e3831; --accent:#8dba96 }
  }
  * { box-sizing: border-box }
  body { margin:0; padding:24px 20px 60px; background:var(--bg); color:var(--ink);
         font:15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif }
  h1 { font-size:26px; margin:0 0 4px } h2 { font-size:20px; margin:0 0 14px }
  h3 { font-size:15px; margin:26px 0 8px; text-transform:uppercase; letter-spacing:.06em; color:var(--soft) }
  .sub { color:var(--soft); margin:0 0 20px }
  table { border-collapse:collapse; width:100%; background:var(--card); font-size:13.5px }
  th,td { border:1px solid var(--line); padding:7px 9px; text-align:left; vertical-align:top }
  th { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--soft); font-weight:600 }
  td.raw, .photos td:not(:first-child):not(:last-child) { font-variant-numeric:tabular-nums; white-space:nowrap }
  .rank { color:var(--soft); width:28px }
  .overview { overflow-x:auto }
  a.model { color:var(--ink); font-weight:600; text-decoration:none; border-bottom:1px dashed var(--accent) }
  em { color:var(--soft); font-style:normal; font-size:12px }
  .pass { color:#2f7a4f; font-size:12px } .fail { color:#a64a3c; font-size:12px }
  @media (prefers-color-scheme: dark) { .pass{color:#7fc295} .fail{color:#e08a7b} }
  .bar { position:relative; display:block; height:19px; background:var(--bg); border:1px solid var(--line); min-width:66px }
  .bar i { position:absolute; inset:0 auto 0 0; display:block; opacity:.35 }
  .bar b { position:relative; font-size:12px; line-height:19px; padding-left:6px; font-variant-numeric:tabular-nums }
  .total .bar { height:23px } .total b { line-height:23px; font-size:13.5px; font-weight:700 }
  nav { display:flex; flex-wrap:wrap; gap:8px; margin:28px 0 18px }
  nav button { font:inherit; font-size:13px; padding:6px 12px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer }
  nav button[aria-current="true"] { background:var(--accent); color:#fff; border-color:var(--accent) }
  .model-page { background:var(--card); border:1px solid var(--line); padding:18px; margin-top:4px }
  .score { background:var(--accent); color:#fff; font-size:14px; padding:2px 10px; vertical-align:middle }
  .criteria { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:18px }
  .crit .t { font-size:12px; font-weight:600; margin-bottom:4px }
  .crit .h { font-size:11px; color:var(--soft); margin-top:4px }
  .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line) }
  .facts > div { background:var(--card); padding:10px 12px }
  .facts > div:last-child { grid-column: auto / -1 }
  .facts span { display:block; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--soft) }
  .facts b { display:block; font-size:20px; font-variant-numeric:tabular-nums; margin:2px 0 }
  .facts i { font-style:normal; font-size:12px; color:var(--soft) }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:14px }
  figure { margin:0; border:1px solid var(--line); padding:8px }
  figure img { width:100%; height:170px; object-fit:cover; display:block }
  figcaption { font-size:12px; margin-top:6px }
  details pre, .photos pre { white-space:pre-wrap; font-size:11px; background:var(--bg); padding:6px; max-height:200px; overflow:auto; margin:6px 0 0 }
  tr.bad td { background:color-mix(in srgb, #a64a3c 12%, transparent) }
  .tags td { font-variant-numeric:tabular-nums }
</style>

<h1>Сравнение моделей${input.holdout ? " · отложенные фото" : ""}</h1>
<p class="sub">Фото: ${input.truths.length} · моделей: ${input.rows.length} · вызовов: ${input.calls.length} · потрачено $${input.totalCostUsd.toFixed(4)}</p>

<div class="overview">
<table>
  <thead><tr>
    <th></th><th>Модель</th><th>Балл</th>
    ${CRITERIA.map((c) => `<th title="${esc(c.hint)}">${c.title}</th>`).join("")}
    <th>ошибка ккал</th><th>ошибка веса</th><th>сбои</th><th>p95</th><th>$/фото</th>
  </tr></thead>
  <tbody>${overviewRows}</tbody>
</table>
</div>

<nav id="nav">${order.map(({ m }, i) => `<button data-target="${slug(m.model)}" aria-current="${i === 0}">${esc(m.model)}</button>`).join("")}</nav>

${sections}

<script>
  const pages = [...document.querySelectorAll(".model-page")];
  const buttons = [...document.querySelectorAll("#nav button")];
  function show(id) {
    for (const p of pages) p.hidden = p.dataset.model !== id;
    for (const b of buttons) b.setAttribute("aria-current", String(b.dataset.target === id));
  }
  for (const b of buttons) b.addEventListener("click", () => show(b.dataset.target));
  for (const a of document.querySelectorAll("a.model")) {
    a.addEventListener("click", () => show(a.dataset.model));
  }
  if (pages.length) show(pages[0].dataset.model);
</script>
`;
}
