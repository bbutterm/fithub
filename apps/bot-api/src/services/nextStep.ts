import type { DietType } from "@prisma/client";

/**
 * Одна строка «что делать дальше» под карточкой приёма пищи.
 *
 * Без модели и без базы: цифры про день уже посчитаны для карточки, а
 * подсказка должна быть мгновенной и предсказуемой. Три правила, не больше:
 *   1) калории за день превышены — сегодня стоп, без нравоучений;
 *   2) вечер, а белок сильно недобран — назвать, чем закрыть;
 *   3) остальное — тишина. Подсказка, которая есть всегда, перестаёт читаться.
 *
 * Белковые примеры зависят от типа питания: веган не должен видеть «творог».
 */
const PROTEIN_SOURCES: Record<DietType, string> = {
  none: "творог, рыба, курица или яйца",
  halal: "творог, рыба, курица или яйца",
  keto: "яйца, рыба, мясо или сыр",
  vegetarian: "творог, яйца, чечевица или тофу",
  vegan: "тофу, чечевица, нут или соевые продукты"
};

export interface NextStepInput {
  /** Локальный час пользователя, 0–23. */
  hourLocal: number;
  dayKcal: number;
  dayProtein: number;
  targetKcal: number | null;
  targetProtein: number | null;
  dietType: DietType;
}

export function nextStepHint(i: NextStepInput): string | null {
  if (i.targetKcal && i.dayKcal > i.targetKcal * 1.05) {
    const over = Math.round(i.dayKcal - i.targetKcal);
    return `⛔️ Сегодня уже +${over} ккал сверх нормы — дальше только вода или чай, а завтра начнём с чистого листа.`;
  }
  if (i.targetProtein && i.hourLocal >= 16) {
    const left = Math.round(i.targetProtein - i.dayProtein);
    if (left >= 25) {
      return `💡 До нормы белка ещё ${left} г — на ужин подойдут ${PROTEIN_SOURCES[i.dietType]}.`;
    }
  }
  return null;
}
