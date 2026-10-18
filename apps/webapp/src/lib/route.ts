export type Tab = "today" | "recipes" | "challenges" | "analytics" | "settings" | "subscription" | "admin";

export interface Route {
  tab: Tab;
  mealId?: number;
}

const SCREENS: Tab[] = ["recipes", "challenges", "settings", "subscription", "analytics"];

/**
 * Куда открыть приложение: из адреса Mini App или из start_param бота.
 *
 * Оба источника приходят от Telegram и содержат что угодно, поэтому id приёма
 * берём только из цифр, а имя экрана — только из известного списка. Всё
 * остальное ведёт на «Сегодня»: пустой экран от кривой ссылки выглядит
 * поломкой приложения.
 */
export function resolveRoute(href: string, startParam: string | undefined): Route {
  const params = new URL(href).searchParams;
  const start = startParam ?? "";
  const mealParam = params.get("meal") ?? (start.startsWith("meal_") ? start.slice(5) : null);
  if (mealParam && /^\d+$/.test(mealParam)) return { tab: "today", mealId: Number(mealParam) };
  const screen = params.get("screen") ?? start;
  return SCREENS.includes(screen as Tab) ? { tab: screen as Tab } : { tab: "today" };
}
