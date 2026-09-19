import type { Meal, MealItem } from "@prisma/client";

const r0 = (v: number) => Math.round(v);

/** Отметка о режиме питания. Зелёная галочка — тоже сигнал: человек видит, что проверка была. */
const DIET_ICONS: Record<string, string> = { ok: "✅", caution: "⚠️", avoid: "🚫" };

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
  tz?: string;
  /** Строка «что делать дальше» — считается снаружи (services/nextStep.ts). */
  nextStep?: string | null;
}): string {
  const { meal, dayKcal, targetKcal, streak, tz } = params;
  const timeLabel = tz
    ? new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(meal.eatenAt)
    : null;
  const lines: string[] = [`🍽 <b>Записал приём пищи</b>${timeLabel ? ` · 🕐 ${timeLabel}` : ""}`, ""];
  for (const it of meal.items) {
    // Граммов нет у записей «по среднему за день» — «0 г» там выглядит ошибкой
    const grams = it.grams > 0 ? `${r0(it.grams)} г · ` : "";
    lines.push(`• ${it.dish} — ${grams}${r0(it.kcal)} ккал (Б ${r0(it.protein)} / Ж ${r0(it.fat)} / У ${r0(it.carbs)})`);
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
  if (meal.dietNote) {
    lines.push("");
    lines.push(`${DIET_ICONS[meal.dietVerdict ?? "caution"] ?? "•"} ${meal.dietNote}`);
  }
  if (meal.aiComment) {
    lines.push("");
    lines.push(`💬 ${meal.aiComment}`);
  }
  if (params.nextStep) {
    lines.push("");
    lines.push(params.nextStep);
  }
  return lines.join("\n");
}

/**
 * Карточка проверки «можно ли мне это?»: та же еда, но НЕ записанная в дневник.
 * Главное здесь — вердикт по режиму питания; КБЖУ — справочно.
 */
export function formatCheckCard(params: {
  items: Array<{ dish: string; grams: number; kcal: number; protein: number; fat: number; carbs: number }>;
  totals: { totalKcal: number; totalProtein: number; totalFat: number; totalCarbs: number };
  dietNote: string | null;
  dietVerdict: string | null;
  hasDiet: boolean;
  comment?: string | null;
}): string {
  const lines: string[] = ["🔎 <b>Проверка</b> · в дневник не записано", ""];
  for (const it of params.items) {
    lines.push(`• ${it.dish} — ${r0(it.grams)} г · ${r0(it.kcal)} ккал (Б ${r0(it.protein)} / Ж ${r0(it.fat)} / У ${r0(it.carbs)})`);
  }
  lines.push("");
  const t = params.totals;
  lines.push(`Итого: ${r0(t.totalKcal)} ккал · Б ${r0(t.totalProtein)} / Ж ${r0(t.totalFat)} / У ${r0(t.totalCarbs)}`);
  lines.push("");
  if (params.dietNote) {
    lines.push(`${DIET_ICONS[params.dietVerdict ?? "caution"] ?? "•"} <b>${params.dietNote}</b>`);
  } else if (params.hasDiet) {
    lines.push("Не смог сверить с режимом питания — попробуй ещё раз чуть позже.");
  } else {
    lines.push("Режим питания не задан. Укажи его в настройках (стол №5, средиземноморская и другие) — и я буду говорить, вписывается ли блюдо.");
  }
  if (params.comment) {
    lines.push("");
    lines.push(`💬 ${params.comment}`);
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
