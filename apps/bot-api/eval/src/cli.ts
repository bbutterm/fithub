import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callModel } from "./client.js";
import { loadDataset, parseCsv, selectItems, type GroundTruth } from "./dataset.js";
import { summarize, type CallRecord, type Truth, type Verdict } from "./metrics.js";
import { bestPairs, calibrate, confidenceSignal, pairedBootstrap, priceFrontier, runsBenefit, splitError } from "./analysis.js";
import { htmlReport, markdownReport } from "./report.js";
import type { ScoreWeights } from "./scoring.js";
import { appendCall, dedupeCalls, doneKeys, readCalls, runDir, writeJson, writeText, type StoredCall } from "./storage.js";
import { agreement, photoConsensus } from "./consensus.js";

/**
 * Одна команда на каждый шаг чек-листа. Прогон перезапускаемый: вышла новая
 * модель — добавили в config.json и запустили ту же команду, уже сделанные
 * вызовы повторно не оплачиваются.
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATASET = path.join(ROOT, "dataset");
const PHOTOS = path.join(DATASET, "photos");
const PREPARED = path.join(DATASET, "prepared");
const LABELS = path.join(DATASET, "labels.csv");
const RUNS = path.join(ROOT, "runs");

interface Config {
  models: string[];
  /** Короткий список для прогонов по своим фотографиям; если пуст — берётся models. */
  inboxModels?: string[];
  baseline: string;
  runs: number;
  temperature: number;
  concurrency: number;
  timeoutSec: number;
  networkRetries: number;
  image: { maxSide: number; quality: number };
  thresholds: { kcalErrorPctMean: number; costPerPhotoUsd: number; latencySecP95: number; failureRatePct: number };
  weights?: ScoreWeights;
}

/**
 * Ключ провайдера: из окружения, иначе из apps/bot-api/.env.
 *
 * Файл .env в репозиторий не попадает, и класть ключ туда — обычный способ
 * работы с ботом. Полноценный разбор dotenv ради одной строки не нужен.
 */
function apiKey(): string | undefined {
  const fromEnv = process.env.VISION_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv;
  const envFile = path.join(path.dirname(ROOT), ".env");
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = /^\s*(VISION_API_KEY|OPENROUTER_API_KEY)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[2]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function config(): Config {
  return JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf-8")) as Config;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function photosDir(): string {
  return existsSync(PREPARED) && readdirSync(PREPARED).length > 0 ? PREPARED : PHOTOS;
}

function dataset(): GroundTruth[] {
  if (!existsSync(LABELS)) {
    console.error(`Нет таблицы ${LABELS}. Скопируйте dataset/labels.example.csv в dataset/labels.csv и заполните.`);
    process.exit(1);
  }
  const { items, problems } = loadDataset(LABELS, photosDir());
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length) {
    console.error(`В таблице ${errors.length} ошибок — сначала команда validate.`);
    process.exit(1);
  }
  return items;
}

/** Путь к прогону: как дали, иначе относительно папки eval — подсказки в выводе печатаются именно так. */
function resolveRun(given: string): string {
  const direct = path.resolve(given);
  if (existsSync(direct)) return direct;
  const inRoot = path.resolve(ROOT, given);
  if (existsSync(inRoot)) return inRoot;
  console.error(`Папки прогона не нашёл: ${given}`);
  process.exit(1);
}

function latestRun(): string {
  if (!existsSync(RUNS)) { console.error("Прогонов ещё не было."); process.exit(1); }
  const dirs = readdirSync(RUNS).sort();
  if (dirs.length === 0) { console.error("Прогонов ещё не было."); process.exit(1); }
  return path.join(RUNS, dirs[dirs.length - 1]!);
}

function toRecords(stored: StoredCall[]): CallRecord[] {
  return stored.map((c) => ({
    model: c.model,
    file: c.file,
    run: c.run,
    ok: c.ok,
    failure: c.failure,
    grams: c.parsed?.grams,
    kcal: c.parsed?.kcal,
    protein: c.parsed?.protein,
    fat: c.parsed?.fat,
    carbs: c.parsed?.carbs,
    latencyMs: c.latencyMs,
    costUsd: c.costUsd,
    networkRetries: c.networkRetries
  }));
}

const toTruths = (items: GroundTruth[]): Truth[] =>
  items.map((i) => ({ file: i.file, grams: i.grams, kcal: i.kcal, protein: i.protein, fat: i.fat, carbs: i.carbs, tags: i.tags }));

type SharpFn = (input: string) => {
  rotate(): ReturnType<SharpFn>;
  resize(opts: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): ReturnType<SharpFn>;
  jpeg(opts: { quality: number }): ReturnType<SharpFn>;
  toFile(out: string): Promise<unknown>;
};

/**
 * sharp нужен, чтобы все модели получали снимок одного размера: иначе дороже
 * обходится не модель, а фотография. Пакет нативный, и на чужой машине его
 * установка может не пройти — поэтому отсутствие не считается ошибкой само по
 * себе, решает вызывающая команда.
 */
async function loadSharp(): Promise<SharpFn | null> {
  try {
    return ((await import("sharp")) as unknown as { default: SharpFn }).default;
  } catch {
    return null;
  }
}

// ─── validate ───────────────────────────────────────────────────────────────
function cmdValidate(): void {
  if (!existsSync(LABELS)) {
    console.error(`Нет ${LABELS}. Скопируйте dataset/labels.example.csv в dataset/labels.csv.`);
    process.exit(1);
  }
  const { items, problems } = loadDataset(LABELS, photosDir());
  const holdout = items.filter((i) => i.holdout);
  console.log(`Строк: ${items.length} · отложено: ${holdout.length} · папка с фото: ${path.relative(ROOT, photosDir())}`);
  const byTag = new Map<string, number>();
  for (const i of items) for (const t of i.tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
  console.log("По типам: " + [...byTag.entries()].map(([t, n]) => `${t} ${n}`).join(", "));

  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warning");
  if (warnings.length) {
    console.log(`\nПредупреждений: ${warnings.length} (прогон не блокируют, но строки стоит перепроверить)`);
    for (const w of warnings) console.log(`  строка ${w.row}: ${w.message}`);
  }
  if (errors.length === 0) {
    console.log("\nОшибок нет.");
    if (items.length < 20) console.log("Подсказка: для первого отсева нужно хотя бы 20 блюд, для выбора модели — 50+.");
    if (holdout.length < 10) console.log("Подсказка: отложите 10–15 фото (holdout=yes) и не смотрите на них до финальной проверки.");
    return;
  }
  console.log(`\nОшибок: ${errors.length}`);
  for (const p of errors) console.log(`  строка ${p.row}: ${p.message}`);
  process.exit(1);
}

// ─── import ─────────────────────────────────────────────────────────────────
/**
 * Импорт готовой подборки: своя таблица разметки превращается в labels.csv.
 *
 * Ожидается папка с `images/` и `dataset.csv` (колонки id, image, complexity,
 * title_ru, description_ru, portion_weight_g, kcal, protein_g, fat_g, carbs_g).
 * Обзорные листы (preview*.jpg) не копируются: подавать их модели вместо
 * исходных фото нельзя.
 */
function cmdImport(): void {
  const from = arg("from");
  if (!from) {
    console.error("Укажите папку подборки: eval import --from ../путь/к/распакованному/архиву");
    process.exit(1);
  }
  const src = path.resolve(from);
  const csvPath = path.join(src, "dataset.csv");
  if (!existsSync(csvPath)) { console.error(`Не нашёл ${csvPath}`); process.exit(1); }

  const rows = parseCsv(readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, ""));
  const header = rows[0]!.map((h) => h.trim());
  const col = (r: string[], name: string) => (r[header.indexOf(name)] ?? "").trim();
  const need = ["image", "title_ru", "portion_weight_g", "kcal", "protein_g", "fat_g", "carbs_g"];
  const missing = need.filter((n) => !header.includes(n));
  if (missing.length) { console.error(`В dataset.csv нет колонок: ${missing.join(", ")}`); process.exit(1); }

  mkdirSync(PHOTOS, { recursive: true });
  const out: string[] = ["file,dish,grams,kcal,protein,fat,carbs,source,tags,holdout"];
  const HIDDEN = /масл|соус|сыр|майонез|заправк|сливк|сметан/i;
  let copied = 0;

  for (const r of rows.slice(1)) {
    const rel = col(r, "image");
    if (!rel || /preview/i.test(rel)) continue;
    const file = path.basename(rel);
    const srcFile = path.join(src, rel);
    if (!existsSync(srcFile)) { console.error(`Нет файла ${rel} — пропускаю`); continue; }
    copyFileSync(srcFile, path.join(PHOTOS, file));
    copied++;

    const grams = Number(col(r, "portion_weight_g"));
    const tags = new Set<string>();
    tags.add(col(r, "complexity") === "complex" ? "mixed" : "simple");
    if (HIDDEN.test(col(r, "description_ru"))) tags.add("hidden");
    if (grams > 0 && grams < 150) tags.add("small");
    if (grams > 400) tags.add("large");

    const round = (v: string) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 10) / 10) : v);
    const dish = col(r, "title_ru").replace(/"/g, "'");
    out.push([
      file, `"${dish}"`, round(col(r, "portion_weight_g")), round(col(r, "kcal")),
      round(col(r, "protein_g")), round(col(r, "fat_g")), round(col(r, "carbs_g")),
      `"${(arg("source") ?? "подборка Nutrition5k").replace(/"/g, "'")}"`,
      [...tags].join(";"), "no"
    ].join(","));
  }

  writeFileSync(LABELS, out.join("\n") + "\n", "utf-8");
  console.log(`Скопировано фото: ${copied}. Таблица: ${path.relative(ROOT, LABELS)}`);
  console.log("Отложенные фото пока не отмечены: проставьте holdout=yes там, где нужно, или добавьте свои снимки.");
  console.log("Дальше: pnpm --filter bot-api eval validate");
}

// ─── scaffold ───────────────────────────────────────────────────────────────
function cmdScaffold(): void {
  const dir = PHOTOS;
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`В ${path.relative(ROOT, dir)} нет фото. Положите снимки туда и повторите.`);
    process.exit(1);
  }
  const header = "file,dish,grams,kcal,protein,fat,carbs,source,tags,holdout";
  const existing = new Map<string, string>();
  if (existsSync(LABELS)) {
    const rows = parseCsv(readFileSync(LABELS, "utf-8"));
    for (const r of rows.slice(1)) if (r[0]) existing.set(r[0].trim(), r.join(","));
  }
  // Уже заполненные строки не трогаем: таблица — результат работы с весами,
  // и перезаписать её одной командой было бы обиднее всего.
  const lines = files.map((f) => existing.get(f) ?? `${f},,,,,,,,simple,no`);
  writeFileSync(LABELS, [header, ...lines].join("\n") + "\n", "utf-8");
  const added = files.filter((f) => !existing.has(f)).length;
  console.log(`Таблица ${path.relative(ROOT, LABELS)}: строк ${files.length}, из них новых ${added}.`);
  console.log("Заполните вес и КБЖУ по весам и упаковкам, затем: pnpm --filter bot-api eval validate");
}

// ─── prepare ────────────────────────────────────────────────────────────────
async function cmdPrepare(): Promise<void> {
  const cfg = config();
  const sharp = await loadSharp();
  if (!sharp) {
    console.error(
      "Для приведения фото к одному размеру нужен sharp:\n" +
        "  pnpm --filter bot-api add -D sharp\n" +
        "Без него можно прогонять и оригиналы, но тогда модели получают разный объём данных."
    );
    process.exit(1);
  }
  mkdirSync(PREPARED, { recursive: true });
  const files = readdirSync(PHOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  for (const f of files) {
    const out = path.join(PREPARED, f.replace(/\.(png|webp)$/i, ".jpg"));
    await sharp(path.join(PHOTOS, f))
      .rotate()
      .resize({ width: cfg.image.maxSide, height: cfg.image.maxSide, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: cfg.image.quality })
      .toFile(out);
  }
  console.log(`Подготовлено ${files.length} фото → ${path.relative(ROOT, PREPARED)} (сторона ${cfg.image.maxSide}, качество ${cfg.image.quality})`);
}

// ─── run ────────────────────────────────────────────────────────────────────
async function cmdRun(): Promise<void> {
  const cfg = config();
  const key = apiKey();
  if (!key) {
    console.error("Нет ключа: задайте VISION_API_KEY в окружении или в apps/bot-api/.env");
    process.exit(1);
  }
  const all = dataset();
  const holdout = has("holdout");
  const pool = all.filter((i) => i.holdout === holdout);
  if (pool.length === 0) {
    console.error(holdout ? "Отложенных фото нет (holdout=yes)." : "В наборе нет рабочих фото.");
    process.exit(1);
  }

  const { selected: items, unknown } = selectItems(pool, {
    only: arg("only"),
    limit: arg("limit") ? Number(arg("limit")) : undefined
  });
  if (unknown.length) {
    console.error(`Нет таких фото в наборе: ${unknown.join(", ")}`);
    process.exit(1);
  }
  if (items.length === 0) {
    console.error("Отбор --only/--limit не оставил ни одного фото.");
    process.exit(1);
  }

  const models = (arg("models")?.split(",").map((m) => m.trim()).filter(Boolean)) ?? cfg.models;
  const runs = Number(arg("runs") ?? cfg.runs);
  // Рассуждающие модели думают дольше флэшевых: без запаса их не измерить,
  // а таймаут запишется как сбой. Ограничение прода (60 с на Vercel)
  // применяется при разборе, а не подменяет собой замер.
  const timeoutSec = Number(arg("timeout") ?? cfg.timeoutSec);
  // Параллельность задаётся на запуск: замер времени требует одного запроса
  // за раз, а добор недостающих вызовов — не упереться в лимит кредитов.
  const concurrency = Math.max(1, Number(arg("concurrency") ?? cfg.concurrency));
  const dir = arg("out") ? path.resolve(ROOT, arg("out")!) : runDir(RUNS, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}${holdout ? "-holdout" : ""}`);
  mkdirSync(dir, { recursive: true });

  const already = doneKeys(readCalls(dir));
  const tasks: Array<{ model: string; item: GroundTruth; run: number }> = [];
  for (const model of models) {
    for (const item of items) {
      for (let run = 1; run <= runs; run++) {
        if (!already.has(`${model}|${item.file}|${run}`)) tasks.push({ model, item, run });
      }
    }
  }

  const planned = models.length * items.length * runs;
  console.log(`Прогон: ${models.length} моделей × ${items.length} фото × ${runs} повторов = ${planned} вызовов`);
  if (already.size) console.log(`Уже сделано раньше: ${already.size}, осталось: ${tasks.length}`);
  writeJson(dir, "config-snapshot.json", { models, runs, temperature: cfg.temperature, image: cfg.image, holdout, startedAt: new Date().toISOString() });

  let done = 0;
  let spent = 0;
  const photos = photosDir();
  const worker = async () => {
    for (;;) {
      const task = tasks.shift();
      if (!task) return;
      const outcome = await callModel({
        model: task.model,
        imagePath: path.join(photos, task.item.file),
        apiKey: key,
        temperature: cfg.temperature,
        timeoutSec,
        networkRetries: cfg.networkRetries
      });
      spent += outcome.costUsd;
      appendCall(dir, {
        model: task.model, file: task.item.file, run: task.run, at: new Date().toISOString(),
        ok: outcome.ok, failure: outcome.failure, httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs, costUsd: outcome.costUsd,
        promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens,
        networkRetries: outcome.networkRetries, parsed: outcome.parsed, raw: outcome.raw
      });
      done++;
      const mark = outcome.ok ? "·" : `✗${outcome.failure}`;
      process.stdout.write(`\r[${done}/${tasks.length + done}] ${task.model} ${task.item.file} ${mark}   `);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`\nГотово. Потрачено примерно $${spent.toFixed(4)}. Папка прогона: ${path.relative(ROOT, dir)}`);
  console.log(`Дальше: pnpm eval score --run ${path.relative(ROOT, dir)}`);
}

// ─── label ──────────────────────────────────────────────────────────────────
function cmdLabel(): void {
  const dir = arg("run") ? resolveRun(arg("run")!) : latestRun();
  const stored = dedupeCalls(readCalls(dir)).filter((c) => c.ok);
  if (stored.length === 0) { console.error("В прогоне нет разобранных ответов."); process.exit(1); }
  const items = dataset();
  const byFile = new Map(items.map((i) => [i.file, i]));

  // Перемешиваем и прячем модель: иначе разметка названий подстраивается под ожидания.
  const shuffled = [...stored].sort(() => Math.random() - 0.5);
  const key = shuffled.map((c, idx) => ({ id: idx + 1, model: c.model, file: c.file, run: c.run }));
  const rows = [["id", "file", "эталон", "ответ модели", "вердикт (верно/близко/мимо)"]];
  shuffled.forEach((c, idx) => {
    rows.push([
      String(idx + 1),
      c.file,
      byFile.get(c.file)?.dish ?? "",
      (c.parsed?.dishes ?? []).join(", "),
      ""
    ]);
  });
  const csv = rows.map((r) => r.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n");
  writeText(dir, "labeling.csv", csv + "\n");
  writeJson(dir, "labeling-key.json", key);
  console.log(`Файл для разметки: ${path.relative(ROOT, path.join(dir, "labeling.csv"))}`);
  console.log("Заполните колонку «вердикт» (верно / близко / мимо) и запустите score — проценты попадут в отчёт.");
  console.log("В файле нет названий моделей: labeling-key.json до конца разметки не открывайте.");
}

function readVerdicts(dir: string): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const csvPath = path.join(dir, "labeling.csv");
  const keyPath = path.join(dir, "labeling-key.json");
  if (!existsSync(csvPath) || !existsSync(keyPath)) return out;
  const key = JSON.parse(readFileSync(keyPath, "utf-8")) as Array<{ id: number; model: string; file: string; run: number }>;
  const byId = new Map(key.map((k) => [k.id, k]));
  const rows = parseCsv(readFileSync(csvPath, "utf-8")).slice(1);
  for (const r of rows) {
    const id = Number(r[0]);
    const verdict = (r[4] ?? "").trim().toLowerCase();
    const k = byId.get(id);
    if (!k) continue;
    if (verdict === "верно" || verdict === "близко" || verdict === "мимо") {
      out.set(`${k.model}|${k.file}|${k.run}`, verdict as Verdict);
    }
  }
  return out;
}

// ─── score ──────────────────────────────────────────────────────────────────
function cmdScore(): void {
  const cfg = config();
  const dir = arg("run") ? resolveRun(arg("run")!) : latestRun();
  const stored = dedupeCalls(readCalls(dir));
  if (stored.length === 0) { console.error("В прогоне нет вызовов."); process.exit(1); }
  const snapshot = JSON.parse(readFileSync(path.join(dir, "config-snapshot.json"), "utf-8")) as { holdout?: boolean };
  const items = dataset().filter((i) => i.holdout === Boolean(snapshot.holdout));
  const calls = toRecords(stored);
  const truths = toTruths(items);
  const verdicts = readVerdicts(dir);
  const models = [...new Set(stored.map((c) => c.model))];
  const rows = models.map((m) => summarize(m, calls, truths, verdicts));
  const totalCost = stored.reduce((s, c) => s + c.costUsd, 0);

  const input = {
    rows, calls, stored, truths,
    thresholds: cfg.thresholds,
    weights: cfg.weights,
    baseline: cfg.baseline,
    totalCostUsd: totalCost,
    photosDir: path.relative(dir, photosDir()),
    holdout: Boolean(snapshot.holdout)
  };
  const md = markdownReport(input);
  writeText(dir, "report.md", md);
  writeJson(dir, "metrics.json", rows);
  writeText(dir, "compare.html", htmlReport(input));
  console.log(md);
  console.log(`\nОтчёт: ${path.relative(ROOT, path.join(dir, "report.md"))}`);
  console.log(`Сравнение моделей: ${path.relative(ROOT, path.join(dir, "compare.html"))}`);
  if (verdicts.size === 0) console.log("Разметки названий ещё нет — команда label создаст файл для неё.");
}

// ─── analyze ────────────────────────────────────────────────────────────────
/**
 * Разборы поверх готового прогона: ничего не вызывается заново, деньги не тратятся.
 */
function cmdAnalyze(): void {
  const dir = arg("run") ? resolveRun(arg("run")!) : latestRun();
  const stored = dedupeCalls(readCalls(dir));
  if (stored.length === 0) { console.error("В прогоне нет вызовов."); process.exit(1); }
  const snapshot = JSON.parse(readFileSync(path.join(dir, "config-snapshot.json"), "utf-8")) as { holdout?: boolean };
  const truths = toTruths(dataset().filter((i) => i.holdout === Boolean(snapshot.holdout)));
  const models = [...new Set(stored.map((c) => c.model))];

  const lines: string[] = ["# Разбор прогона", ""];

  const volume = Number(arg("photos-per-month") ?? 1000);
  const records = toRecords(stored);
  const prices = priceFrontier(
    models.map((m) => {
      const s = summarize(m, records, truths);
      return { model: m, costPerPhotoUsd: s.costPerPhotoUsd, errorPct: s.kcalErrorPctMedian };
    }),
    volume
  );
  if (prices.length) {
    lines.push("## Цена против точности");
    lines.push("");
    lines.push(`| Модель | Медиана ошибки | $/фото | Дороже дешёвой | $ за пункт точности на 1000 фото | $/мес при ${volume} фото | На границе |`);
    lines.push("|---|---|---|---|---|---|---|");
    for (const p of prices) {
      lines.push(
        `| ${p.model} | ${p.errorPct}% | $${p.costPerPhotoUsd.toFixed(5)} | ×${p.timesCheapest} | ` +
        `${p.usdPerPointPer1k === null ? "—" : "$" + p.usdPerPointPer1k} | $${p.costPerMonthUsd} | ${p.onFrontier ? "да" : "нет"} |`
      );
    }
    lines.push("");
    lines.push("На границе остаются модели, которых никто не обошёл сразу и по цене, и по точности: остальные платить за себя не просят, они просто хуже. Цена пункта считается от самой дешёвой модели прогона — это и есть ответ на вопрос «во что обойдётся точность».");
    lines.push("");
  }

  const ranked = [...prices].sort((a, b) => a.errorPct - b.errorPct).map((p) => p.model);
  if (ranked.length > 1) {
    lines.push("## Значима ли разница");
    lines.push("");
    lines.push("| Кто лучше | Кого обошёл | Медианы на общих снимках | Разрыв | 95% интервал | Снимков в пользу лучшей | Значимо |");
    lines.push("|---|---|---|---|---|---|---|");
    for (let i = 0; i < ranked.length - 1; i++) {
      const c = pairedBootstrap(ranked[i]!, ranked[i + 1]!, stored, truths);
      if (!c) continue;
      lines.push(
        `| ${c.better} | ${c.worse} | ${c.medianBetter}% против ${c.medianWorse}% | ${c.gapPct} п.п. | ` +
        `${c.ci95[0]}…${c.ci95[1]} п.п. | ${c.winRatePct}% | ${c.significant ? "да" : "нет"} |`
      );
    }
    const top = pairedBootstrap(ranked[0]!, ranked[ranked.length - 1]!, stored, truths);
    if (top) {
      lines.push(
        `| ${top.better} | ${top.worse} | ${top.medianBetter}% против ${top.medianWorse}% | ${top.gapPct} п.п. | ` +
        `${top.ci95[0]}…${top.ci95[1]} п.п. | ${top.winRatePct}% | ${top.significant ? "да" : "нет"} |`
      );
    }
    const topMean = pairedBootstrap(ranked[0]!, ranked[ranked.length - 1]!, stored, truths, { metric: "mean" });
    if (topMean) {
      lines.push(
        `| ${topMean.better} | ${topMean.worse} | ${topMean.medianBetter}% против ${topMean.medianWorse}% (среднее) | ` +
        `${topMean.gapPct} п.п. | ${topMean.ci95[0]}…${topMean.ci95[1]} п.п. | ${topMean.winRatePct}% | ` +
        `${topMean.significant ? "да" : "нет"} |`
      );
    }
    lines.push("");
    lines.push("Соседи по таблице сравниваются попарно, последняя строка — лучшая против худшей. Снимки парные: обе модели видели одни и те же, поэтому разброс самих блюд из сравнения уходит. Интервал получен бутстрэпом по снимкам (2000 пересборок, фиксированное зерно). Если он задевает ноль, разницу нельзя отличить от удачной подборки фотографий.");
    lines.push("");
  }

  lines.push("## Откуда ошибка: вес порции или состав");
  lines.push("");
  lines.push("| Модель | Общая ошибка | Ошибка веса | Ошибка состава | Доля веса в ошибке |");
  lines.push("|---|---|---|---|---|");
  const splits = models.map((m) => splitError(m, stored, truths)).sort((a, b) => a.totalPct - b.totalPct);
  for (const s of splits) {
    lines.push(`| ${s.model} | ${s.totalPct}% | ${s.weightPct}% | ${s.compositionPct}% | ${s.weightSharePct}% |`);
  }
  lines.push("");
  lines.push("Ошибка состава — это то, что останется, если подставить правильный вес. Большая доля веса означает, что боту выгоднее спрашивать граммы, чем менять модель.");

  lines.push("");
  lines.push("## Поправочный коэффициент");
  lines.push("");
  lines.push("| Модель | Множитель | Ошибка до | Ошибка после |");
  lines.push("|---|---|---|---|");
  for (const c of models.map((m) => calibrate(m, stored, truths)).sort((a, b) => a.after - b.after)) {
    lines.push(`| ${c.model} | ×${c.factor} | ${c.before}% | ${c.after}% |`);
  }
  lines.push("");
  lines.push("Если после умножения на константу ошибка заметно падает, модель не врёт случайно, а стабильно смещена — это чинится одной строкой в боте.");

  const benefits = models.map((m) => runsBenefit(m, stored, truths)).filter((b) => b.runs > 1);
  if (benefits.length) {
    lines.push("");
    lines.push("## Стоит ли платить за несколько прогонов");
    lines.push("");
    lines.push("| Модель | Один ответ | Медиана прогонов | Прогонов |");
    lines.push("|---|---|---|---|");
    for (const b of benefits) lines.push(`| ${b.model} | ${b.single}% | ${b.medianOfRuns}% | ${b.runs} |`);
  }

  if (models.length > 1) {
    lines.push("");
    lines.push("## Пары моделей");
    lines.push("");
    lines.push("| Пара | Ошибка пары | Лучшая из двух | Выигрыш | Цена пары |");
    lines.push("|---|---|---|---|---|");
    for (const p of bestPairs(models, stored, truths, 5)) {
      lines.push(`| ${p.models.join(" + ")} | ${p.pairPct}% | ${p.bestSinglePct}% | ${p.gainPct > 0 ? "+" : ""}${p.gainPct} п.п. | $${p.costUsd} |`);
    }
    lines.push("");
    lines.push("Среднее двух ответов иногда точнее одного дорогого. Считается по уже сделанным вызовам, новых денег не требует.");
  }

  lines.push("");
  lines.push("## Честна ли модель про свою уверенность");
  lines.push("");
  lines.push("| Модель | Доля неуверенных | Ошибка у них | Ошибка у остальных | Переспрос оправдан |");
  lines.push("|---|---|---|---|---|");
  for (const c of models.map((m) => confidenceSignal(m, stored, truths))) {
    lines.push(`| ${c.model} | ${c.belowPct}% | ${c.errorBelow}% | ${c.errorAbove}% | ${c.useful ? "да" : "нет"} |`);
  }
  lines.push("");
  lines.push("Бот переспрашивает дорогой моделью при уверенности ниже 0.7. Если ошибка у неуверенных ответов не выше, этот переспрос только удваивает счёт.");
  lines.push("");

  const md = lines.join("\n");
  writeText(dir, "analysis.md", md);
  console.log(md);
  console.log(`\nСохранено: ${path.relative(ROOT, path.join(dir, "analysis.md"))}`);
}

// ─── inbox ──────────────────────────────────────────────────────────────────
/**
 * Прогон по своей папке с фотографиями.
 *
 * Отличие от run одно, но важное: эталона может не быть. Человек кидает в
 * папку снимок обеда и хочет увидеть, что скажут модели; взвешивать каждую
 * тарелку он не станет. Если рядом лежит labels.csv — считается точность,
 * если нет — согласие моделей между собой.
 */
async function cmdInbox(): Promise<void> {
  const cfg = config();
  const key = apiKey();
  if (!key) {
    console.error("Нет ключа: задайте VISION_API_KEY в окружении или в apps/bot-api/.env");
    process.exit(1);
  }

  const dir = path.resolve(ROOT, arg("dir") ?? "inbox");
  // Папка может лежать и вне eval: тогда относительный путь выродится
  // в десяток «..», и в отчёте полезнее абсолютный.
  const shown = (p: string) => (path.relative(ROOT, p).startsWith("..") ? p : path.relative(ROOT, p));
  if (!existsSync(dir)) {
    console.error(`Нет папки ${dir}. Создайте её и положите туда фотографии.`);
    process.exit(1);
  }
  const photos = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (photos.length === 0) {
    console.error(`В ${shown(dir)} нет фотографий (.jpg, .png, .webp).`);
    process.exit(1);
  }

  // Эталон необязателен: без него точность посчитать не из чего, но сравнить
  // модели между собой всё равно можно.
  const labelsPath = path.join(dir, "labels.csv");
  let truths: Truth[] = [];
  if (existsSync(labelsPath)) {
    const { items, problems } = loadDataset(labelsPath, dir);
    const errors = problems.filter((p) => p.severity === "error");
    if (errors.length) {
      console.error(`В ${shown(labelsPath)} ошибки:`);
      for (const p of errors) console.error(`  строка ${p.row}: ${p.message}`);
      process.exit(1);
    }
    for (const p of problems) console.warn(`замечание, строка ${p.row}: ${p.message}`);
    truths = toTruths(items);
  }

  const models =
    (arg("models")?.split(",").map((m) => m.trim()).filter(Boolean)) ??
    (cfg.inboxModels?.length ? cfg.inboxModels : cfg.models);
  const runs = Number(arg("runs") ?? 1);
  const timeoutSec = Number(arg("timeout") ?? cfg.timeoutSec);
  const concurrency = Math.max(1, Number(arg("concurrency") ?? cfg.concurrency));

  const planned = models.length * photos.length * runs;
  const maxCalls = Number(arg("max-calls") ?? 400);
  if (planned > maxCalls) {
    console.error(
      `Вышло бы ${planned} вызовов (${photos.length} фото × ${models.length} моделей × ${runs} повторов), ` +
        `а предел ${maxCalls}. Уберите фотографии, сократите --models или поднимите --max-calls осознанно.`
    );
    process.exit(1);
  }

  const out = arg("out")
    ? path.resolve(ROOT, arg("out")!)
    : runDir(RUNS, `inbox-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
  mkdirSync(out, { recursive: true });

  // Снимок с телефона весит мегабайты, и платить пришлось бы за них, а не за
  // модель. Ужимаем в папку прогона — оригиналы в inbox остаются нетронутыми.
  const sharp = await loadSharp();
  let imagesDir = dir;
  let resized = false;
  if (sharp) {
    imagesDir = path.join(out, "prepared");
    mkdirSync(imagesDir, { recursive: true });
    for (const f of photos) {
      await sharp(path.join(dir, f))
        .rotate()
        .resize({ width: cfg.image.maxSide, height: cfg.image.maxSide, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: cfg.image.quality })
        .toFile(path.join(imagesDir, f));
    }
    resized = true;
  } else {
    // Без sharp большой снимок молча утроит счёт, поэтому лучше остановиться.
    const heavy = photos.filter((f) => statSync(path.join(dir, f)).size > 1_500_000);
    if (heavy.length && !has("allow-big")) {
      console.error(
        `Нет sharp, а эти снимки тяжелее полутора мегабайт: ${heavy.join(", ")}.\n` +
          "Установите sharp (pnpm --filter bot-api add -D sharp), ужмите фотографии сами " +
          "или запустите с --allow-big, понимая, что счёт вырастет."
      );
      process.exit(1);
    }
  }

  writeJson(out, "config-snapshot.json", {
    models, runs, temperature: cfg.temperature, image: cfg.image, resized,
    source: shown(dir), withTruth: truths.length > 0, startedAt: new Date().toISOString()
  });

  const already = doneKeys(readCalls(out));
  const tasks: Array<{ model: string; file: string; run: number }> = [];
  for (const model of models) {
    for (const file of photos) {
      for (let run = 1; run <= runs; run++) {
        if (!already.has(`${model}|${file}|${run}`)) tasks.push({ model, file, run });
      }
    }
  }

  console.log(
    `Прогон по папке ${shown(dir)}: ${photos.length} фото × ${models.length} моделей × ${runs} ` +
      `= ${planned} вызовов${truths.length ? " (эталон есть)" : " (эталона нет, считаем согласие)"}`
  );

  let done = 0;
  let spent = 0;
  const worker = async () => {
    for (;;) {
      const task = tasks.shift();
      if (!task) return;
      const outcome = await callModel({
        model: task.model, imagePath: path.join(imagesDir, task.file), apiKey: key,
        temperature: cfg.temperature, timeoutSec, networkRetries: cfg.networkRetries
      });
      spent += outcome.costUsd;
      appendCall(out, {
        model: task.model, file: task.file, run: task.run, at: new Date().toISOString(),
        ok: outcome.ok, failure: outcome.failure, httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs, costUsd: outcome.costUsd,
        promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens,
        networkRetries: outcome.networkRetries, parsed: outcome.parsed, raw: outcome.raw
      });
      done++;
      process.stdout.write(`\r[${done}/${tasks.length + done}] ${task.model} ${task.file} ${outcome.ok ? "·" : `✗${outcome.failure}`}   `);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`\nГотово. Потрачено примерно $${spent.toFixed(4)}.`);

  const stored = dedupeCalls(readCalls(out));
  const md = inboxReport(stored, truths, photos.length, models, runs, shown(dir), resized, cfg.image.maxSide);
  writeText(out, "inbox.md", md);
  console.log("\n" + md);

  const summary = arg("summary") ?? process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    writeFileSync(summary, md, { flag: "a" });
    console.log(`\nОтчёт дописан в ${summary}`);
  }
  console.log(`Папка прогона: ${path.relative(ROOT, out)}`);
}

/** Отчёт по своей папке: с эталоном считается точность, без — согласие. */
function inboxReport(
  stored: StoredCall[], truths: Truth[], photos: number,
  models: string[], runs: number, source: string, resized: boolean, maxSide: number
): string {
  const spent = stored.reduce((s, c) => s + c.costUsd, 0);
  const lines: string[] = [
    `## Прогон по папке \`${source}\``,
    "",
    `Фотографий: ${photos} · моделей: ${models.length} · повторов: ${runs} · ` +
      `вызовов: ${stored.length} · потрачено: $${spent.toFixed(4)}`,
    "",
    resized
      ? `Снимки ужаты до ${maxSide} пикселей по длинной стороне — так же, как основной набор.`
      : "Снимки отправлены как есть: sharp не установлен, размеры у моделей разные.",
    ""
  ];

  if (truths.length) {
    const records = toRecords(stored);
    const rows = models
      .map((m) => summarize(m, records, truths))
      .sort((a, b) => a.kcalErrorPctMedian - b.kcalErrorPctMedian);
    lines.push("### Точность по эталону", "");
    lines.push("| Модель | Медиана ошибки | Среднее | Ошибка веса | Сбои | Ответ | $/фото |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of rows) {
      lines.push(
        `| ${r.model} | ${r.kcalErrorPctMedian}% | ${r.kcalErrorPctMean}% | ${r.gramsErrorPctMean}% | ` +
          `${r.failureRatePct}% | ${r.latencySecMean} с | $${r.costPerPhotoUsd.toFixed(5)} |`
      );
    }
    lines.push("");
    if (photos < 20) {
      lines.push(
        `> На ${photos} снимках разницу между моделями измерить нельзя: интервал неопределённости ` +
          "здесь шире любого разрыва в таблице. Эти числа говорят, что произошло на ваших снимках, " +
          "и не говорят, какая модель лучше вообще."
      );
      lines.push("");
    }
  }

  const rows = agreement(stored);
  lines.push(truths.length ? "### Согласие между моделями" : "### Согласие между моделями (эталона нет)", "");
  lines.push("| Модель | Отклонение от остальных | Смещение | Выше всех | Ниже всех | Сбои | Ответ | $/фото |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${r.model} | ${r.deviationPctMedian}% | ${r.biasPctMean > 0 ? "+" : ""}${r.biasPctMean}% | ` +
        `${r.highestCount} | ${r.lowestCount} | ${r.failureRatePct}% | ${r.latencySecMedian} с | ` +
        `$${r.costPerPhotoUsd.toFixed(5)} |`
    );
  }
  lines.push("");
  lines.push(
    "Согласие — это не точность. Модели умеют ошибаться хором: на плотной еде со скрытым жиром " +
      "занижает весь набор сразу. Таблица отвечает, кто выбивается из общего мнения и в какую сторону, " +
      "а не кто прав."
  );
  lines.push("");

  lines.push("### Что увидели на каждом снимке", "");
  lines.push("| Снимок | Общее мнение | Разброс | От и до | Названия блюд |");
  lines.push("|---|---|---|---|---|");
  for (const p of photoConsensus(stored)) {
    const truth = truths.find((t) => t.file === p.file);
    const centre = truth ? `${Math.round(truth.kcal)} ккал (эталон)` : `${p.consensusKcal} ккал`;
    lines.push(
      `| ${p.file} | ${centre} | ×${p.spreadRatio} | ${p.minKcal}–${p.maxKcal} | ${p.dishes.slice(0, 3).join(" · ")} |`
    );
  }
  lines.push("");
  lines.push("Снимки отсортированы по разбросу: сверху те, где модели не сошлись во мнении сильнее всего.");
  lines.push("");

  const failures = stored.filter((c) => !c.ok);
  if (failures.length) {
    lines.push("### Сбои", "");
    for (const f of failures.slice(0, 12)) {
      lines.push(`- \`${f.model}\` на ${f.file}: ${f.failure}${f.httpStatus ? ` (HTTP ${f.httpStatus})` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── main ───────────────────────────────────────────────────────────────────
const commands: Record<string, () => void | Promise<void>> = {
  import: cmdImport,
  scaffold: cmdScaffold,
  validate: cmdValidate,
  prepare: cmdPrepare,
  run: cmdRun,
  inbox: cmdInbox,
  label: cmdLabel,
  score: cmdScore,
  analyze: cmdAnalyze
};

const command = process.argv[2] ?? "";
if (!commands[command]) {
  console.log(`Инструменты eval. Команды:

  pnpm eval import --from <папка>    импортировать готовую подборку (images/ + dataset.csv)
  pnpm eval scaffold                 создать строки таблицы по именам файлов в dataset/photos
  pnpm eval validate                 проверить таблицу эталона и фото
  pnpm eval prepare                  привести фото к одному размеру и качеству
  pnpm eval run [--models a,b]       прогон (перезапускаемый), [--runs 3] [--holdout] [--out runs/имя]
                                    [--only 008,022] [--limit 20] — зондаж на части набора
                                    [--timeout 120] [--concurrency 1] — запас времени и параллельность
  pnpm eval inbox [--dir inbox]     прогон по своей папке с фото, [--models a,b] [--runs 1]
                                    [--max-calls 400] [--summary файл] — эталон необязателен
  pnpm eval label [--run папка]      файл для слепой разметки названий блюд
  pnpm eval score [--run папка]      метрики, отсев по порогам, отчёт и страница сравнения
  pnpm eval analyze [--run папка]    разбор: цена против точности, вес против состава, поправка, пары, уверенность
                                    [--photos-per-month 1000] — объём для месячного счёта

Порядок: scaffold → validate → prepare → run → label → score.
Пороги и список моделей — в eval/config.json.`);
  process.exit(command ? 1 : 0);
}
await commands[command]!();
