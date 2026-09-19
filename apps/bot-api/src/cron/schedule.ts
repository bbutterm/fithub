// Чистые правила расписания рассылок — без обращений к БД, боту и провайдерам,
// чтобы их можно было покрыть тестами (остальной код cron тянет за собой config,
// который при отсутствии переменных окружения останавливает процесс).

/**
 * Пора ли слать месячный отчёт при данной локальной дате и часе пользователя.
 *
 * Окно — первые три дня месяца, а не только первое число. Причина: на плане Hobby
 * крон будит раз в сутки в фиксированный час UTC, и условие «1-е число после 10:00
 * локального времени» для западных таймзон не наступает никогда — на следующем тике
 * уже 2-е число, и отчёт не уходит вообще.
 *
 * Первые два дня ждём приличного часа, на третий шлём в любом случае: лучше отчёт
 * в неудобное время, чем без отчёта. Повторы отсекает уникальный ключ DailyAdvice.
 */
export function shouldSendMonthly(localDate: string, localHour: number): boolean {
  const day = Number(localDate.slice(8, 10));
  if (!Number.isFinite(day) || day < 1 || day > 3) return false;
  return day === 3 || localHour >= 9;
}

/** Разбивка на пачки: пользователи обрабатываются параллельно, но не все разом. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Слать ли вечернее напоминание «сегодня в дневнике пусто».
 *
 * Крон один раз в сутки в фиксированный час UTC, поэтому проверяем окно
 * локального вечера, а не точное время: попали в 17:00–23:59 — шлём. Кому:
 *   - день пуст (иначе напоминать не о чем);
 *   - сегодня ещё не слали;
 *   - человек живой: писал что-то за последние 14 дней или зарегистрировался
 *     за последние 3 дня. Тем, кто бросил месяц назад, ежедневные «ты ничего
 *     не записал» — это спам, а не забота.
 */
export function shouldRemind(i: {
  localHour: number;
  mealsToday: number;
  lastReminderDate: string | null;
  today: string;
  daysSinceLastMeal: number | null;
  daysSinceSignup: number;
}): boolean {
  if (i.localHour < 17) return false;
  if (i.mealsToday > 0) return false;
  if (i.lastReminderDate === i.today) return false;
  const alive = (i.daysSinceLastMeal !== null && i.daysSinceLastMeal <= 14) || i.daysSinceSignup <= 3;
  return alive;
}
