import { prisma } from "../db.js";
import { assignRanks, FEED_REPORTS_TO_HIDE, rankFeedCandidates, weekRangeUtc } from "../feed.js";

/**
 * Общая лента еды: публикация своих фото, голосование, недельный лидерборд.
 *
 * Правило приватности одно и оно жёсткое: ни один приём пищи не попадает в
 * ленту сам по себе. Нужно либо нажать кнопку под карточкой, либо один раз
 * включить тумблер «публиковать автоматически» — по умолчанию он выключен.
 */

/** Сколько карточек отдаём за раз: экран свайпов держит небольшую очередь. */
const DEFAULT_BATCH = 10;
/** Из скольких кандидатов выбираем — чтобы не тянуть всю ленту на каждый свайп. */
const CANDIDATE_WINDOW = 100;

export interface FeedCard {
  mealId: number;
  authorId: number;
  authorName: string;
  dish: string;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  likeCount: number;
  voteCount: number;
  publishedAt: string | null;
}

function authorNameOf(firstName: string | null): string {
  return firstName?.trim() || "Повар";
}

function dishesOf(items: Array<{ dish: string }>): string {
  return items.map((i) => i.dish).join(", ") || "приём пищи";
}

/** Публикация приёма в ленту. Без фото публиковать нечего — лента про фото. */
export async function publishMeal(mealId: number, userId: number): Promise<"published" | "already" | "no_photo" | "not_found"> {
  const meal = await prisma.meal.findFirst({ where: { id: mealId, userId }, select: { photoFileId: true, isPublic: true } });
  if (!meal) return "not_found";
  if (!meal.photoFileId) return "no_photo";
  if (meal.isPublic) return "already";
  await prisma.meal.update({ where: { id: mealId }, data: { isPublic: true, publishedAt: new Date() } });
  return "published";
}

/**
 * Снять из ленты. Голоса не удаляем: человек может вернуть фото обратно, а
 * лидерборд всё равно считает только по опубликованным приёмам.
 */
export async function unpublishMeal(mealId: number, userId: number): Promise<boolean> {
  const res = await prisma.meal.updateMany({ where: { id: mealId, userId, isPublic: true }, data: { isPublic: false } });
  return res.count > 0;
}

/**
 * Автопубликация для тех, кто включил тумблер. Вызывается после создания приёма.
 * Молчит при любой ошибке: не попасть в ленту неприятно, потерять из-за этого
 * запись в дневнике — хуже.
 */
export async function autoPublishIfOptedIn(mealId: number, userId: number): Promise<boolean> {
  const profile = await prisma.profile.findUnique({ where: { userId }, select: { feedOptIn: true } }).catch(() => null);
  if (!profile?.feedOptIn) return false;
  const res = await publishMeal(mealId, userId).catch(() => "not_found" as const);
  return res === "published";
}

/** Очередь карточек для свайпов: чужие, опубликованные, ещё не оценённые этим человеком. */
export async function feedBatch(viewerId: number, limit = DEFAULT_BATCH): Promise<FeedCard[]> {
  const candidates = await prisma.meal.findMany({
    where: {
      isPublic: true,
      feedHiddenAt: null,
      photoFileId: { not: null },
      userId: { not: viewerId },
      feedVotes: { none: { voterId: viewerId } }
    },
    // Порядок в базе совпадает с правилом ранжирования — окно берём уже «правильное»,
    // а окончательный порядок всё равно задаёт rankFeedCandidates (одно место для правила).
    orderBy: [{ voteCount: "asc" }, { publishedAt: "desc" }, { id: "desc" }],
    take: CANDIDATE_WINDOW,
    include: { items: { select: { dish: true } }, user: { select: { id: true, firstName: true } } }
  });

  return rankFeedCandidates(candidates)
    .slice(0, limit)
    .map((m) => ({
      mealId: m.id,
      authorId: m.user.id,
      authorName: authorNameOf(m.user.firstName),
      dish: dishesOf(m.items),
      kcal: Math.round(m.totalKcal),
      protein: Math.round(m.totalProtein),
      fat: Math.round(m.totalFat),
      carbs: Math.round(m.totalCarbs),
      likeCount: m.likeCount,
      voteCount: m.voteCount,
      publishedAt: m.publishedAt?.toISOString() ?? null
    }));
}

export type VoteResult =
  | { ok: true; counted: boolean; likeCount: number }
  | { ok: false; reason: "not_found" | "own_meal" };

/**
 * Голос за карточку. Повторный голос не считается: счётчики денормализованы, и
 * второй инкремент от того же человека накрутил бы лидерборд.
 */
export async function voteFeedMeal(viewerId: number, mealId: number, liked: boolean): Promise<VoteResult> {
  const meal = await prisma.meal.findFirst({
    where: { id: mealId, isPublic: true, feedHiddenAt: null },
    select: { userId: true, likeCount: true }
  });
  if (!meal) return { ok: false, reason: "not_found" };
  if (meal.userId === viewerId) return { ok: false, reason: "own_meal" };

  // skipDuplicates вместо «прочитать и вставить»: две вкладки подряд иначе
  // дают два инкремента на один голос.
  const created = await prisma.feedVote.createMany({
    data: [{ mealId, voterId: viewerId, liked }],
    skipDuplicates: true
  });
  if (created.count === 0) return { ok: true, counted: false, likeCount: meal.likeCount };

  const updated = await prisma.meal.update({
    where: { id: mealId },
    data: { voteCount: { increment: 1 }, ...(liked ? { likeCount: { increment: 1 } } : {}) },
    select: { likeCount: true }
  });
  return { ok: true, counted: true, likeCount: updated.likeCount };
}

/** Жалоба на карточку. Две жалобы прячут её до разбора админом. */
export async function reportFeedMeal(viewerId: number, mealId: number): Promise<{ ok: boolean; hidden: boolean }> {
  const meal = await prisma.meal.findFirst({ where: { id: mealId, isPublic: true }, select: { feedHiddenAt: true } });
  if (!meal) return { ok: false, hidden: false };
  await prisma.feedReport.createMany({ data: [{ mealId, reporterId: viewerId }], skipDuplicates: true });
  const reports = await prisma.feedReport.count({ where: { mealId } });
  if (reports >= FEED_REPORTS_TO_HIDE && !meal.feedHiddenAt) {
    await prisma.meal.update({ where: { id: mealId }, data: { feedHiddenAt: new Date() } });
    return { ok: true, hidden: true };
  }
  return { ok: true, hidden: Boolean(meal.feedHiddenAt) };
}

export interface LeaderboardRow {
  rank: number;
  userId: number;
  name: string;
  likes: number;
  meals: number;
  isMe: boolean;
}

export interface Leaderboard {
  weekKey: string;
  rows: LeaderboardRow[];
  me: LeaderboardRow | null;
  /** Сколько лайков до места выше; null — если выше некуда или человека нет в таблице. */
  toNextRank: number | null;
}

/**
 * Недельный лидерборд авторов: сумма лайков, полученных за текущую неделю.
 *
 * Неделя общая для всех (московская), сбрасывается в понедельник — чтобы
 * человек, пришедший в среду, играл не против накопленного за год.
 */
export async function weeklyLeaderboard(now: Date, viewerId: number | null, limit = 10): Promise<Leaderboard> {
  const week = weekRangeUtc(now);
  const raw = await prisma.$queryRaw<Array<{ userId: number; firstName: string | null; likes: bigint; meals: bigint }>>`
    SELECT m."userId"            AS "userId",
           u."firstName"         AS "firstName",
           COUNT(*)              AS likes,
           COUNT(DISTINCT m.id)  AS meals
      FROM "FeedVote" v
      JOIN "Meal" m ON m.id = v."mealId"
      JOIN "User" u ON u.id = m."userId"
     WHERE v.liked
       AND v."createdAt" >= ${week.start}
       AND v."createdAt" <  ${week.end}
       AND m."isPublic"
       AND m."feedHiddenAt" IS NULL
     GROUP BY m."userId", u."firstName"
  `;
  const ranked = assignRanks(raw.map((r) => ({ ...r, likes: Number(r.likes), meals: Number(r.meals) })));
  const all: LeaderboardRow[] = ranked.map(({ row, rank }) => ({
    rank,
    userId: row.userId,
    name: authorNameOf(row.firstName),
    likes: row.likes,
    meals: row.meals,
    isMe: row.userId === viewerId
  }));

  const me = all.find((r) => r.isMe) ?? null;
  // Ближайший сосед сверху — тот, у кого лайков больше всех среди тех, кто выше.
  const above = me ? all.filter((r) => r.likes > me.likes) : [];
  const toNext = me && above.length ? Math.min(...above.map((r) => r.likes)) - me.likes : null;

  return { weekKey: week.key, rows: all.slice(0, limit), me, toNextRank: toNext };
}

export interface TopMeal {
  mealId: number;
  authorId: number;
  authorName: string;
  dish: string;
  kcal: number;
  likes: number;
}

/** Топ блюд недели — для воскресного дайджеста в боте. */
export async function topMealsOfWeek(now: Date, limit = 3): Promise<TopMeal[]> {
  const week = weekRangeUtc(now);
  const raw = await prisma.$queryRaw<Array<{ mealId: number; likes: bigint }>>`
    SELECT v."mealId" AS "mealId", COUNT(*) AS likes
      FROM "FeedVote" v
      JOIN "Meal" m ON m.id = v."mealId"
     WHERE v.liked
       AND v."createdAt" >= ${week.start}
       AND v."createdAt" <  ${week.end}
       AND m."isPublic"
       AND m."feedHiddenAt" IS NULL
     GROUP BY v."mealId"
     ORDER BY likes DESC, v."mealId" ASC
     LIMIT ${limit}
  `;
  if (raw.length === 0) return [];
  const meals = await prisma.meal.findMany({
    where: { id: { in: raw.map((r) => r.mealId) } },
    include: { items: { select: { dish: true } }, user: { select: { id: true, firstName: true } } }
  });
  const byId = new Map(meals.map((m) => [m.id, m]));
  return raw.flatMap((r) => {
    const m = byId.get(r.mealId);
    if (!m) return [];
    return [{
      mealId: m.id,
      authorId: m.user.id,
      authorName: authorNameOf(m.user.firstName),
      dish: dishesOf(m.items),
      kcal: Math.round(m.totalKcal),
      likes: Number(r.likes)
    }];
  });
}

/** Моя статистика в ленте: сколько опубликовано и сколько лайков за неделю. */
export async function myFeedStats(userId: number, now: Date): Promise<{ published: number; likesThisWeek: number }> {
  const week = weekRangeUtc(now);
  const [published, likesThisWeek] = await Promise.all([
    prisma.meal.count({ where: { userId, isPublic: true, feedHiddenAt: null } }),
    prisma.feedVote.count({
      where: { liked: true, createdAt: { gte: week.start, lt: week.end }, meal: { userId, isPublic: true, feedHiddenAt: null } }
    })
  ]);
  return { published, likesThisWeek };
}

/** Доступен ли приём в ленте — нужно фото-прокси, чтобы отдать чужое фото. */
export async function isMealInFeed(mealId: number): Promise<boolean> {
  const meal = await prisma.meal.findFirst({ where: { id: mealId, isPublic: true, feedHiddenAt: null }, select: { id: true } });
  return Boolean(meal);
}
