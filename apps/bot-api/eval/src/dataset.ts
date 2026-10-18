import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Набор данных: таблица с эталоном и фото рядом.
 *
 * Формат нарочно простой — CSV, который открывается в любой таблице: заполнять
 * его придётся руками после кухонных весов, и чем меньше в нём магии, тем
 * меньше шансов испортить эталон опечаткой в кавычках.
 */

export const TAGS = ["simple", "mixed", "hidden", "small", "large", "lowlight", "multi"] as const;
export type Tag = (typeof TAGS)[number];

export interface GroundTruth {
  file: string;
  dish: string;
  grams: number;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  source: string;
  tags: Tag[];
  holdout: boolean;
}

/** Минимальный разбор CSV: запятая-разделитель, кавычки для полей с запятыми. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const REQUIRED = ["file", "dish", "grams", "kcal", "protein", "fat", "carbs", "source", "tags", "holdout"];

export interface DatasetProblem {
  row: number;
  message: string;
}

export interface LoadedDataset {
  items: GroundTruth[];
  problems: DatasetProblem[];
}

/**
 * Читает таблицу и сразу проверяет её.
 *
 * Проверки нужны до прогона, а не после: ошибка в эталоне сделает «победителем»
 * модель, которая ошибается так же, как опечатка.
 */
export function loadDataset(csvPath: string, photosDir: string): LoadedDataset {
  const rows = parseCsv(readFileSync(csvPath, "utf-8"));
  const problems: DatasetProblem[] = [];
  const items: GroundTruth[] = [];
  if (rows.length === 0) return { items, problems: [{ row: 0, message: "таблица пустая" }] };

  const header = rows[0]!.map((h) => h.trim());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    return { items, problems: [{ row: 1, message: `нет колонок: ${missing.join(", ")}` }] };
  }
  const col = (r: string[], name: string) => (r[header.indexOf(name)] ?? "").trim();
  const seen = new Set<string>();

  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const file = col(r, "file");
    const add = (message: string) => problems.push({ row: rowNo, message });
    if (!file) return add("пустое имя файла");
    if (seen.has(file)) add(`файл ${file} встречается дважды`);
    seen.add(file);
    if (!existsSync(path.join(photosDir, file))) add(`файла ${file} нет в папке с фото`);

    if (!col(r, "dish")) add("не заполнено название блюда");

    const nums: Record<string, number> = {};
    for (const key of ["grams", "kcal", "protein", "fat", "carbs"]) {
      const raw = col(r, key).replace(",", ".");
      // Пустая ячейка — это не ноль, а незаполненная строка: Number("") даёт 0,
      // и половина таблицы проходила бы проверку как «еда без калорий».
      if (raw === "") { add(`${key}: не заполнено`); nums[key] = NaN; continue; }
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) add(`${key}: «${raw}» — не число`);
      nums[key] = v;
    }

    const tags = col(r, "tags").split(";").map((t) => t.trim()).filter(Boolean);
    const badTags = tags.filter((t) => !TAGS.includes(t as Tag));
    if (badTags.length) add(`неизвестные метки: ${badTags.join(", ")} (есть ${TAGS.join(", ")})`);
    if (tags.length === 0) add("нет ни одной метки типа блюда");

    const holdoutRaw = col(r, "holdout").toLowerCase();
    if (!["yes", "no", "да", "нет", ""].includes(holdoutRaw)) add(`holdout: «${holdoutRaw}» — ожидается yes или no`);

    // Сходимость КБЖУ и калорий по Этуотеру: расхождение больше четверти почти
    // всегда означает описку в граммах или в строке таблицы калорийности.
    const byMacros = nums.protein! * 4 + nums.fat! * 9 + nums.carbs! * 4;
    if (Number.isFinite(byMacros) && nums.kcal! > 0 && byMacros > 0 && Math.abs(byMacros - nums.kcal!) / nums.kcal! > 0.25) {
      add(`ккал (${nums.kcal}) расходится с Б/Ж/У (${Math.round(byMacros)}) больше чем на четверть — проверьте строку`);
    }

    items.push({
      file,
      dish: col(r, "dish"),
      grams: nums.grams!,
      kcal: nums.kcal!,
      protein: nums.protein!,
      fat: nums.fat!,
      carbs: nums.carbs!,
      source: col(r, "source"),
      tags: tags as Tag[],
      holdout: holdoutRaw === "yes" || holdoutRaw === "да"
    });
  });

  return { items, problems };
}
