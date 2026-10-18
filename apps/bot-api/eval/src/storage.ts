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

export function doneKeys(calls: StoredCall[]): Set<string> {
  return new Set(calls.map((c) => `${c.model}|${c.file}|${c.run}`));
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
