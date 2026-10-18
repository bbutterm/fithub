import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callModel } from "./client.js";
import { loadDataset, parseCsv, type GroundTruth } from "./dataset.js";
import { summarize, type CallRecord, type Truth, type Verdict } from "./metrics.js";
import { htmlReport, markdownReport } from "./report.js";
import { appendCall, doneKeys, readCalls, runDir, writeJson, writeText, type StoredCall } from "./storage.js";

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
  baseline: string;
  runs: number;
  temperature: number;
  concurrency: number;
  timeoutSec: number;
  networkRetries: number;
  image: { maxSide: number; quality: number };
  thresholds: { kcalErrorPctMean: number; costPerPhotoUsd: number; latencySecP95: number; failureRatePct: number };
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
  if (problems.length) {
    console.error(`В таблице ${problems.length} проблем — сначала команда validate.`);
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

  if (problems.length === 0) {
    console.log("\nПроблем нет.");
    if (items.length < 20) console.log("Подсказка: для первого отсева нужно хотя бы 20 блюд, для выбора модели — 50+.");
    if (holdout.length < 10) console.log("Подсказка: отложите 10–15 фото (holdout=yes) и не смотрите на них до финальной проверки.");
    return;
  }
  console.log(`\nПроблем: ${problems.length}`);
  for (const p of problems) console.log(`  строка ${p.row}: ${p.message}`);
  process.exit(1);
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
  type SharpFn = (input: string) => {
    rotate(): ReturnType<SharpFn>;
    resize(opts: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): ReturnType<SharpFn>;
    jpeg(opts: { quality: number }): ReturnType<SharpFn>;
    toFile(out: string): Promise<unknown>;
  };
  let sharp: SharpFn | null = null;
  try {
    sharp = ((await import("sharp")) as unknown as { default: SharpFn }).default;
  } catch {
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
  const apiKey = process.env.VISION_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Нет ключа: задайте VISION_API_KEY (или OPENROUTER_API_KEY).");
    process.exit(1);
  }
  const all = dataset();
  const holdout = has("holdout");
  const items = all.filter((i) => i.holdout === holdout);
  if (items.length === 0) {
    console.error(holdout ? "Отложенных фото нет (holdout=yes)." : "В наборе нет рабочих фото.");
    process.exit(1);
  }

  const models = (arg("models")?.split(",").map((m) => m.trim()).filter(Boolean)) ?? cfg.models;
  const runs = Number(arg("runs") ?? cfg.runs);
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
        apiKey,
        temperature: cfg.temperature,
        timeoutSec: cfg.timeoutSec,
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
  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
  console.log(`\nГотово. Потрачено примерно $${spent.toFixed(4)}. Папка прогона: ${path.relative(ROOT, dir)}`);
  console.log(`Дальше: pnpm eval score --run ${path.relative(ROOT, dir)}`);
}

// ─── label ──────────────────────────────────────────────────────────────────
function cmdLabel(): void {
  const dir = arg("run") ? resolveRun(arg("run")!) : latestRun();
  const stored = readCalls(dir).filter((c) => c.ok);
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
  const stored = readCalls(dir);
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
    baseline: cfg.baseline,
    totalCostUsd: totalCost,
    photosDir: path.relative(dir, photosDir()),
    holdout: Boolean(snapshot.holdout)
  };
  const md = markdownReport(input);
  writeText(dir, "report.md", md);
  writeJson(dir, "metrics.json", rows);
  writeText(dir, "misses.html", htmlReport(input, md));
  console.log(md);
  console.log(`\nОтчёт: ${path.relative(ROOT, path.join(dir, "report.md"))}`);
  console.log(`Промахи с фото: ${path.relative(ROOT, path.join(dir, "misses.html"))}`);
  if (verdicts.size === 0) console.log("Разметки названий ещё нет — команда label создаст файл для неё.");
}

// ─── main ───────────────────────────────────────────────────────────────────
const commands: Record<string, () => void | Promise<void>> = {
  scaffold: cmdScaffold,
  validate: cmdValidate,
  prepare: cmdPrepare,
  run: cmdRun,
  label: cmdLabel,
  score: cmdScore
};

const command = process.argv[2] ?? "";
if (!commands[command]) {
  console.log(`Инструменты eval. Команды:

  pnpm eval scaffold                 создать строки таблицы по именам файлов в dataset/photos
  pnpm eval validate                 проверить таблицу эталона и фото
  pnpm eval prepare                  привести фото к одному размеру и качеству
  pnpm eval run [--models a,b]       прогон (перезапускаемый), [--runs 3] [--holdout] [--out путь]
  pnpm eval label [--run папка]      файл для слепой разметки названий блюд
  pnpm eval score [--run папка]      метрики, отсев по порогам, отчёт и промахи с фото

Порядок: scaffold → validate → prepare → run → label → score.
Пороги и список моделей — в eval/config.json.`);
  process.exit(command ? 1 : 0);
}
await commands[command]!();
