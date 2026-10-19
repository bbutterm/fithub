import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDataset, parseCsv, selectItems, type GroundTruth } from "../src/dataset.js";

const HEADER = "file,dish,grams,kcal,protein,fat,carbs,source,tags,holdout";

function fixture(rows: string[], files: string[] = ["a.jpg"]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eval-ds-"));
  const photos = path.join(dir, "photos");
  mkdirSync(photos);
  for (const f of files) writeFileSync(path.join(photos, f), "x");
  const csv = path.join(dir, "labels.csv");
  writeFileSync(csv, [HEADER, ...rows].join("\n") + "\n");
  return { csv, photos };
}

describe("разбор CSV", () => {
  it("читает поля с запятой внутри кавычек", () => {
    expect(parseCsv('a,"б, в",г\n1,2,3')).toEqual([["a", "б, в", "г"], ["1", "2", "3"]]);
  });

  it("пустые строки пропускаются", () => {
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("проверка набора", () => {
  it("корректная строка читается без замечаний", () => {
    const { csv, photos } = fixture(["a.jpg,яблоко,180,94,0.5,0.3,24.8,таблица,simple,no"]);
    const { items, problems } = loadDataset(csv, photos);
    expect(problems).toEqual([]);
    expect(items[0]).toMatchObject({ file: "a.jpg", grams: 180, kcal: 94, tags: ["simple"], holdout: false });
  });

  it("пропавшее фото, дубль и нечисло называются по строкам", () => {
    const { csv, photos } = fixture([
      "a.jpg,яблоко,180,94,0.5,0.3,24.8,таблица,simple,no",
      "нет.jpg,суп,300,200,10,5,20,таблица,mixed,no",
      "a.jpg,яблоко,сто,94,0.5,0.3,24.8,таблица,simple,no"
    ]);
    const { problems } = loadDataset(csv, photos);
    const text = problems.map((p) => `${p.row}:${p.message}`).join(" | ");
    expect(text).toContain("нет.jpg");
    expect(text).toContain("дважды");
    expect(text).toContain("не число");
  });

  it("пустые ячейки не проходят как нули", () => {
    const { csv, photos } = fixture(["a.jpg,,,,,,,,simple,no"]);
    const { problems } = loadDataset(csv, photos);
    const text = problems.map((p) => p.message).join(" | ");
    expect(text).toContain("название блюда");
    expect(text).toContain("grams: не заполнено");
    expect(text).toContain("kcal: не заполнено");
  });

  it("расхождение калорий с Б/Ж/У — предупреждение, а не блокировка", () => {
    const { csv, photos } = fixture(["a.jpg,каша,200,900,5,5,30,таблица,simple,no"]);
    const { items, problems } = loadDataset(csv, photos);
    const about = problems.filter((p) => p.message.includes("расходится"));
    expect(about).toHaveLength(1);
    expect(about[0]!.severity).toBe("warning");
    expect(problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(items).toHaveLength(1); // строка всё равно попадает в набор
  });

  it("умеренное расхождение, обычное для таблиц калорийности, не тревожит", () => {
    // 386 ккал против 491 по Этуотеру: отношение 0.79, внутри коридора
    const { csv, photos } = fixture(["a.jpg,рагу,300,386,25,20,60,таблица,mixed,no"]);
    expect(loadDataset(csv, photos).problems).toEqual([]);
  });

  it("неизвестная метка типа блюда отвергается, отложенные фото отмечаются", () => {
    const { csv, photos } = fixture(["a.jpg,яблоко,180,94,0.5,0.3,24.8,таблица,вкусное,да"]);
    const { items, problems } = loadDataset(csv, photos);
    expect(problems.some((p) => p.message.includes("неизвестные метки"))).toBe(true);
    expect(items[0]!.holdout).toBe(true);
  });

  it("отсутствие нужной колонки — одна понятная ошибка, а не сто", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eval-ds-"));
    const csv = path.join(dir, "labels.csv");
    writeFileSync(csv, "file,dish\na.jpg,яблоко\n");
    const { problems } = loadDataset(csv, dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("нет колонок");
  });
});

describe("selectItems", () => {
  const items = ["001.jpg", "008.jpg", "022.jpg"].map((file) => ({ file }) as GroundTruth);

  it("без отбора возвращает весь набор, --limit отрезает хвост", () => {
    expect(selectItems(items, {}).selected).toHaveLength(3);
    expect(selectItems(items, { limit: 2 }).selected.map((i) => i.file)).toEqual(["001.jpg", "008.jpg"]);
  });

  it("--only берёт названные фото в заданном порядке, с расширением и без", () => {
    const { selected, unknown } = selectItems(items, { only: "022, 001.jpg, 022" });
    expect(selected.map((i) => i.file)).toEqual(["022.jpg", "001.jpg"]);
    expect(unknown).toEqual([]);
  });

  it("несуществующее имя возвращается отдельно, а не молча выпадает", () => {
    const { selected, unknown } = selectItems(items, { only: "008,999" });
    expect(selected.map((i) => i.file)).toEqual(["008.jpg"]);
    expect(unknown).toEqual(["999"]);
  });
});
