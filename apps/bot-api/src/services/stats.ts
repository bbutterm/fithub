import type { Profile } from "@prisma/client";
import { prisma } from "../db.js";
import { addDays, localDateStr, zonedDayRangeUtc } from "../utils/tz.js";
import { getDietPreset, normalizeDiets } from "../diets.js";

export interface DayStat {
  date: string;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  mealsCount: number;
  lateMeals: number; // приёмы после 21:00 локального времени
  hadBreakfast: boolean; // приём до 11:00
  dishes: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Постатистика по дням за период [endDate - days + 1 .. endDate] в таймзоне пользователя. */
export async function getDailyStats(userId: number, tz: string, days: number, endDate?: string): Promise<DayStat[]> {
  const end = endDate ?? localDateStr(tz);
  const startDate = addDays(end, -(days - 1));
  const { start } = zonedDayRangeUtc(startDate, tz);
  const { end: rangeEnd } = zonedDayRangeUtc(end, tz);

  const meals = await prisma.meal.findMany({
    where: { userId, eatenAt: { gte: start, lt: rangeEnd } },
    include: { items: { select: { dish: true } } },
    orderBy: { eatenAt: "asc" }
  });

  const byDate = new Map<string, DayStat>();
  for (let i = 0; i < days; i++) {
    const d = addDays(startDate, i);
    byDate.set(d, { date: d, kcal: 0, protein: 0, fat: 0, carbs: 0, mealsCount: 0, lateMeals: 0, hadBreakfast: false, dishes: [] });
  }
  const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const m of meals) {
    const d = dateFmt.format(m.eatenAt);
    const stat = byDate.get(d);
    if (!stat) continue;
    stat.kcal = r1(stat.kcal + m.totalKcal);
    stat.protein = r1(stat.protein + m.totalProtein);
    stat.fat = r1(stat.fat + m.totalFat);
    stat.carbs = r1(stat.carbs + m.totalCarbs);
    stat.mealsCount += 1;
    const hour = Number(hourFmt.format(m.eatenAt));
    if (hour >= 21) stat.lateMeals += 1;
    if (hour < 11) stat.hadBreakfast = true;
    stat.dishes.push(...m.items.map((i) => i.dish));
  }
  return [...byDate.values()];
}

/** Стрик подряд идущих дней с записями, заканчивая сегодняшним или вчерашним днём. */
export function calcStreak(stats: DayStat[]): number {
  const desc = [...stats].sort((a, b) => (a.date < b.date ? 1 : -1));
  let streak = 0;
  for (let i = 0; i < desc.length; i++) {
    const s = desc[i];
    if (!s) break;
    if (s.mealsCount > 0) streak++;
    else if (i === 0) continue; // сегодня ещё может не быть записей — не рвём стрик
    else break;
  }
  return streak;
}

export interface WeekPatterns {
  daysLogged: number;
  skippedBreakfasts: number;
  lateDinnerDays: number;
  emptyDays: number;
  repeatedDishes: Array<{ dish: string; count: number }>;
}

export function detectPatterns(stats: DayStat[]): WeekPatterns {
  const daysLogged = stats.filter((s) => s.mealsCount > 0).length;
  const skippedBreakfasts = stats.filter((s) => s.mealsCount > 0 && !s.hadBreakfast).length;
  const lateDinnerDays = stats.filter((s) => s.lateMeals > 0).length;
  const emptyDays = stats.filter((s) => s.mealsCount === 0).length;
  const dishCount = new Map<string, number>();
  for (const s of stats) for (const d of s.dishes) dishCount.set(d.toLowerCase(), (dishCount.get(d.toLowerCase()) ?? 0) + 1);
  const repeatedDishes = [...dishCount.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dish, count]) => ({ dish, count }));
  return { daysLogged, skippedBreakfasts, lateDinnerDays, emptyDays, repeatedDishes };
}

function medicalDietsLine(ids: string[]): string | null {
  const labels = normalizeDiets(ids).map((id) => getDietPreset(id)!.label);
  if (labels.length === 0) return null;
  return `Режим питания (соблюдать строго, советы не должны ему противоречить): ${labels.join(", ")}`;
}

export function formatProfileBlock(p: Profile): string {
  const lines = [
    `Цель: ${{ lose: "похудение", maintain: "поддержание", gain: "набор массы" }[p.goal]}`,
    `Диета: ${{ none: "обычная", vegetarian: "вегетарианская", vegan: "веганская", keto: "кето", halal: "халяль" }[p.dietType]}`,
    p.targetKcal ? `Цель по калориям: ${p.targetKcal} ккал (Б ${p.targetProtein ?? "?"} / Ж ${p.targetFat ?? "?"} / У ${p.targetCarbs ?? "?"})` : null,
    p.allergies.length ? `Аллергии: ${p.allergies.join(", ")}` : null,
    p.dislikes.length ? `Не любит: ${p.dislikes.join(", ")}` : null,
    // Лечебный режим важнее остального: совет, противоречащий назначению врача,
    // хуже, чем отсутствие совета. Поэтому он идёт последним и с пометкой.
    medicalDietsLine(p.medicalDiets),
    p.dietNotes?.trim() ? `Дополнительные ограничения: ${p.dietNotes.trim()}` : null
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatStatsBlock(stats: DayStat[], targetKcal: number | null): string {
  const patterns = detectPatterns(stats);
  const lines = stats.map((s) =>
    s.mealsCount === 0
      ? `${s.date}: записей нет`
      : `${s.date}: ${Math.round(s.kcal)} ккал (Б ${Math.round(s.protein)} / Ж ${Math.round(s.fat)} / У ${Math.round(s.carbs)}), приёмов: ${s.mealsCount}${s.lateMeals ? ", есть поздний ужин" : ""}${s.hadBreakfast ? "" : ", без завтрака"}`
  );
  if (targetKcal) lines.push(`Цель: ${targetKcal} ккал/день`);
  lines.push(
    `Паттерны: дней с записями ${patterns.daysLogged}/7, пропусков завтрака ${patterns.skippedBreakfasts}, дней с поздним ужином ${patterns.lateDinnerDays}, пустых дней ${patterns.emptyDays}` +
      (patterns.repeatedDishes.length
        ? `, часто повторяются: ${patterns.repeatedDishes.map((d) => `${d.dish} (${d.count}×)`).join(", ")}`
        : "")
  );
  return lines.join("\n");
}

export function formatYesterdayBlock(stats: DayStat[], tz: string): string {
  const yesterday = addDays(localDateStr(tz), -1);
  const s = stats.find((x) => x.date === yesterday);
  if (!s || s.mealsCount === 0) return "Вчера записей не было.";
  return `Вчера: ${Math.round(s.kcal)} ккал, блюда: ${s.dishes.join(", ")}`;
}
