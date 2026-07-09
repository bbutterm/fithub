import type { Meal, MealItem } from "@prisma/client";

const r0 = (v: number) => Math.round(v);

export function progressBar(current: number, target: number, width = 8): string {
  if (target <= 0) return "";
  const filled = Math.min(width, Math.round((current / target) * width));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export function formatMealCard(params: {
  meal: Meal & { items: MealItem[] };
  dayKcal: number;
  targetKcal: number | null;
  streak?: number;
}): string {
  const { meal, dayKcal, targetKcal, streak } = params;
  const lines: string[] = ["🍽 <b>Записал приём пищи</b>", ""];
  for (const it of meal.items) {
    lines.push(`• ${it.dish} — ${r0(it.grams)} г · ${r0(it.kcal)} ккал (Б ${r0(it.protein)} / Ж ${r0(it.fat)} / У ${r0(it.carbs)})`);
  }
  lines.push("");
  lines.push(
    `<b>Итого: ${r0(meal.totalKcal)} ккал</b> · Б ${r0(meal.totalProtein)} / Ж ${r0(meal.totalFat)} / У ${r0(meal.totalCarbs)}`
  );
  if (targetKcal) {
    lines.push(`Сегодня: ${r0(dayKcal)} / ${targetKcal} ккал  ${progressBar(dayKcal, targetKcal)}`);
  } else {
    lines.push(`Сегодня: ${r0(dayKcal)} ккал`);
  }
  if (streak && streak >= 2) {
    lines.push(`🔥 ${streak >= 14 ? "14+" : streak} дн. подряд с записями — так держать!`);
  }
  if (meal.overallConfidence !== null && meal.overallConfidence < 0.6) {
    lines.push("");
    lines.push("⚠️ Не уверен в оценке — ответь на это сообщение уточнением («это была индейка, 200 г») и я пересчитаю.");
  }
  if (meal.aiComment) {
    lines.push("");
    lines.push(`💬 ${meal.aiComment}`);
  }
  return lines.join("\n");
}

export function formatDaySummary(params: {
  totals: { totalKcal: number; totalProtein: number; totalFat: number; totalCarbs: number };
  meals: Array<Meal & { items: MealItem[] }>;
  targetKcal: number | null;
  targetProtein: number | null;
  targetFat: number | null;
  targetCarbs: number | null;
  tz: string;
}): string {
  const { totals, meals, targetKcal } = params;
  const lines: string[] = ["📊 <b>Сегодня</b>", ""];
  if (meals.length === 0) {
    lines.push("Записей пока нет. Пришли фото еды или опиши её текстом 🙂");
    return lines.join("\n");
  }
  const timeFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: params.tz, hour: "2-digit", minute: "2-digit" });
  for (const m of meals) {
    const names = m.items.map((i) => i.dish).join(", ") || "приём пищи";
    lines.push(`${timeFmt.format(m.eatenAt)} — ${names} · ${r0(m.totalKcal)} ккал`);
  }
  lines.push("");
  const target = targetKcal ? ` / ${targetKcal}` : "";
  lines.push(`<b>Итого: ${r0(totals.totalKcal)}${target} ккал</b>  ${targetKcal ? progressBar(totals.totalKcal, targetKcal) : ""}`);
  const fmtT = (v: number, t: number | null) => `${r0(v)}${t ? `/${t}` : ""}`;
  lines.push(
    `Б ${fmtT(totals.totalProtein, params.targetProtein)} · Ж ${fmtT(totals.totalFat, params.targetFat)} · У ${fmtT(totals.totalCarbs, params.targetCarbs)}`
  );
  return lines.join("\n");
}
