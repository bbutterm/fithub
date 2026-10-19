import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CallOutcome } from "./client.js";

/**
 * Хранение прогона: по строке JSON на вызов.
 *
 * Формат выбран ради перезапуска. Прогон 50 фото на 4 моделях в 3 повтора —
 * это 600 платных вызовов; падение на середине не должно стоить денег второй
 * раз, поэтому готовые тройки «модель-фото-повтор» при перезапуске пропускаются.
 */

export interface StoredCall {
  model: string;
  file: string;
  run: number;
  at: string;
  ok: boolean;
  failure?: string;
  httpStatus?: number;
  latencyMs: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  networkRetries: number;
  parsed?: CallOutcome["parsed"];
  raw: string;
}

export function runDir(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function callsPath(dir: string): string {
  return path.join(dir, "calls.jsonl");
}

export function readCalls(dir: string): StoredCall[] {
  const file = callsPath(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StoredCall);
}

export function appendCall(dir: string, call: StoredCall): void {
  appendFileSync(callsPath(dir), JSON.stringify(call) + "\n", "utf-8");
}

/**
 * Сбой на стороне площадки, а не модели: кончились кредиты, упёрлись в лимит
 * запросов, легла сеть. Записывать такое в результат модели нельзя — иначе
 * пустой кошелёк навсегда останется в отчёте как «модель не отвечает».
 */
export function isInfrastructureFailure(call: StoredCall): boolean {
  if (call.ok) return false;
  if (call.failure === "network") return true;
  if (call.failure !== "http") return false;
  const s = call.httpStatus ?? 0;
  return s === 402 || s === 408 || s === 429 || s >= 500;
}

/**
 * Что уже сделано и повторять не нужно. Ответ модели — даже неудачный —
 * считается сделанным: кривой JSON и отказ это свойства модели, за них
 * заплачено и их нужно видеть в метриках. Сбой площадки — нет.
 */
export function doneKeys(calls: StoredCall[]): Set<string> {
  const keys = new Set<string>();
  for (const c of calls) {
    const key = `${c.model}|${c.file}|${c.run}`;
    if (isInfrastructureFailure(c)) keys.delete(key);
    else keys.add(key);
  }
  return keys;
}

/**
 * Последняя запись на каждую тройку «модель-фото-повтор».
 *
 * После добора в файле лежат и старый сбой площадки, и удачный повтор; без
 * этого фильтра метрики посчитали бы оба.
 */
export function dedupeCalls(calls: StoredCall[]): StoredCall[] {
  const last = new Map<string, StoredCall>();
  for (const c of calls) last.set(`${c.model}|${c.file}|${c.run}`, c);
  return [...last.values()];
}

export function writeJson(dir: string, name: string, data: unknown): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
  return p;
}

export function writeText(dir: string, name: string, text: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, text, "utf-8");
  return p;
}
