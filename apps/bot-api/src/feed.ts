import { addDays, localDateStr, zonedTimeToUtc } from "./utils/tz.js";

/**
 * Чистые правила общей ленты еды: неделя лидерборда, порядок карточек, места.
 *
 * Здесь нет обращений к базе — чтобы правила можно было проверить тестами, а не
 * догадываться о них по SQL.
 */

/**
 * Лидерборд общий для всех, значит и неделя у него одна. Иначе у человека в
 * Владивостоке она заканчивалась бы на семь часов раньше, чем у соседа по
 * таблице, и «топ недели» означал бы разное для разных людей.
 */
export const FEED_WEEK_TZ = "Europe/Moscow";

/** Порог жалоб, после которого карточка прячется до разбора. */
export const FEED_REPORTS_TO_HIDE = 2;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 0 — понедельник, 6 — воскресенье, в заданной таймзоне. */
function weekdayIndex(tz: string, now: Date): number {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const idx = WEEKDAYS.indexOf(short);
  return idx < 0 ? 0 : idx;
}

/**
 * Границы текущей недели лидерборда: с понедельника 00:00 до следующего
 * понедельника 00:00 по московскому времени.
 *
 * `key` — дата понедельника (YYYY-MM-DD): по ней отличают одну неделю от другой,
 * не сравнивая даты.
 */
export function weekRangeUtc(now: Date, tz: string = FEED_WEEK_TZ): { start: Date; end: Date; key: string } {
  const today = localDateStr(tz, now);
  const monday = addDays(today, -weekdayIndex(tz, now));
  return {
    start: zonedTimeToUtc(monday, "00:00", tz),
    end: zonedTimeToUtc(addDays(monday, 7), "00:00", tz),
    key: monday
  };
}

export interface RankableCard {
  id: number;
  voteCount: number;
  publishedAt: Date | null;
}

/**
 * Порядок карточек в ленте: сначала те, кого почти не оценивали, внутри —
 * свежие.
 *
 * Не случайный порядок: иначе новое фото может неделю никому не попасться, а
 * лидерборд превратится в «кому повезло». Правило одинаково для всех, поэтому
 * оценки распределяются ровно, и у вчерашнего новичка есть шанс против старожила.
 */
export function rankFeedCandidates<T extends RankableCard>(cards: T[]): T[] {
  return [...cards].sort((a, b) => {
    if (a.voteCount !== b.voteCount) return a.voteCount - b.voteCount;
    const at = a.publishedAt?.getTime() ?? 0;
    const bt = b.publishedAt?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return b.id - a.id;
  });
}

export interface RankedRow<T> {
  row: T;
  rank: number;
}

/**
 * Места в таблице с учётом равных результатов: два первых места — оба первые,
 * следующий занимает третье. Своё место человек видит по тому же правилу, что и
 * чужое, иначе таблица и подпись «ты 4-й» расходятся.
 */
export function assignRanks<T extends { likes: number }>(rows: T[]): Array<RankedRow<T>> {
  const sorted = [...rows].sort((a, b) => b.likes - a.likes);
  const out: Array<RankedRow<T>> = [];
  let rank = 0;
  let prevLikes: number | null = null;
  sorted.forEach((row, i) => {
    if (prevLikes === null || row.likes !== prevLikes) {
      rank = i + 1;
      prevLikes = row.likes;
    }
    out.push({ row, rank });
  });
  return out;
}
