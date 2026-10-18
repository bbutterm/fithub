import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db.js";
import {
  autoPublishIfOptedIn, feedBatch, isMealInFeed, myFeedStats, publishMeal,
  reportFeedMeal, topMealsOfWeek, unpublishMeal, voteFeedMeal, weeklyLeaderboard
} from "../../services/feed.js";
import { makeMeal } from "./helpers.js";

/** Понедельник 00:00 МСК текущей недели — считается независимо от кода ленты. */
function mondayMsk(now: Date): Date {
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Moscow", weekday: "short" }).format(now)
  );
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const monday = new Date(`${d}T00:00:00+03:00`);
  monday.setUTCDate(monday.getUTCDate() - (idx < 0 ? 0 : idx));
  return monday;
}

const user = (tgId: number, firstName: string) => prisma.user.create({ data: { tgUserId: BigInt(tgId), firstName } });

let anna: { id: number };
let boris: { id: number };
let clara: { id: number };
const now = new Date();

beforeEach(async () => {
  [anna, boris, clara] = await Promise.all([user(600001, "Анна"), user(600002, "Борис"), user(600003, "Клара")]);
});

describe("публикация в ленту", () => {
  it("приём с фото публикуется по явной команде", async () => {
    const meal = await makeMeal(anna.id, { dish: "борщ" });
    expect(await publishMeal(meal.id, anna.id)).toBe("published");
    expect(await isMealInFeed(meal.id)).toBe(true);
  });

  it("без фото публиковать нечего, чужое — не твоё", async () => {
    const noPhoto = await makeMeal(anna.id, { photoFileId: null });
    expect(await publishMeal(noPhoto.id, anna.id)).toBe("no_photo");
    const mine = await makeMeal(anna.id);
    expect(await publishMeal(mine.id, boris.id)).toBe("not_found");
  });

  it("автопубликация работает только при включённом тумблере", async () => {
    const first = await makeMeal(boris.id);
    expect(await autoPublishIfOptedIn(first.id, boris.id)).toBe(false);

    await prisma.profile.create({ data: { userId: boris.id, feedOptIn: true, updatedAt: new Date() } });
    const second = await makeMeal(boris.id);
    expect(await autoPublishIfOptedIn(second.id, boris.id)).toBe(true);
  });
});

describe("очередь свайпов", () => {
  it("показывает чужие опубликованные карточки с именем автора", async () => {
    const meal = await makeMeal(anna.id, { dish: "борщ" });
    await publishMeal(meal.id, anna.id);
    const cards = await feedBatch(boris.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ dish: "борщ", authorName: "Анна" });
  });

  it("не показывает своё, неопубликованное и уже оценённое", async () => {
    const own = await makeMeal(boris.id);
    await publishMeal(own.id, boris.id);
    const hidden = await makeMeal(anna.id); // не публикуем
    const voted = await makeMeal(anna.id);
    await publishMeal(voted.id, anna.id);
    await voteFeedMeal(boris.id, voted.id, true);

    const ids = (await feedBatch(boris.id)).map((c) => c.mealId);
    expect(ids).not.toContain(own.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(voted.id);
  });

  it("сначала наименее оценённые, внутри — свежие", async () => {
    const old = await makeMeal(anna.id, { dish: "старое" });
    await publishMeal(old.id, anna.id);
    await voteFeedMeal(boris.id, old.id, true);
    const fresh = await makeMeal(anna.id, { dish: "свежее" });
    await publishMeal(fresh.id, anna.id);

    expect((await feedBatch(clara.id)).map((c) => c.dish)).toEqual(["свежее", "старое"]);
  });
});

describe("голоса", () => {
  it("лайк засчитывается один раз", async () => {
    const meal = await makeMeal(anna.id);
    await publishMeal(meal.id, anna.id);

    const first = await voteFeedMeal(boris.id, meal.id, true);
    expect(first).toEqual({ ok: true, counted: true, likeCount: 1 });
    const again = await voteFeedMeal(boris.id, meal.id, true);
    expect(again).toEqual({ ok: true, counted: false, likeCount: 1 });
  });

  it("за своё голосовать нельзя, за неопубликованное — тоже", async () => {
    const mine = await makeMeal(anna.id);
    await publishMeal(mine.id, anna.id);
    expect(await voteFeedMeal(anna.id, mine.id, true)).toEqual({ ok: false, reason: "own_meal" });

    const unpublished = await makeMeal(anna.id);
    expect(await voteFeedMeal(boris.id, unpublished.id, true)).toEqual({ ok: false, reason: "not_found" });
  });

  it("скип считается оценкой, но не лайком", async () => {
    const meal = await makeMeal(anna.id);
    await publishMeal(meal.id, anna.id);
    await voteFeedMeal(boris.id, meal.id, false);
    expect(await prisma.meal.findUniqueOrThrow({ where: { id: meal.id } })).toMatchObject({ voteCount: 1, likeCount: 0 });
  });
});

describe("жалобы", () => {
  it("две жалобы от разных людей прячут карточку", async () => {
    const meal = await makeMeal(anna.id);
    await publishMeal(meal.id, anna.id);

    expect((await reportFeedMeal(boris.id, meal.id)).hidden).toBe(false);
    expect((await reportFeedMeal(boris.id, meal.id)).hidden).toBe(false); // повтор того же человека
    expect((await reportFeedMeal(clara.id, meal.id)).hidden).toBe(true);
    expect(await isMealInFeed(meal.id)).toBe(false);
  });

  it("жалоба на неопубликованное ничего не делает", async () => {
    const meal = await makeMeal(anna.id);
    expect(await reportFeedMeal(boris.id, meal.id)).toEqual({ ok: false, hidden: false });
  });
});

describe("недельный лидерборд", () => {
  it("считает лайки текущей недели и выдаёт места", async () => {
    const annaMeal = await makeMeal(anna.id);
    const borisMeal = await makeMeal(boris.id);
    await publishMeal(annaMeal.id, anna.id);
    await publishMeal(borisMeal.id, boris.id);
    await voteFeedMeal(boris.id, annaMeal.id, true);
    await voteFeedMeal(anna.id, borisMeal.id, true);
    await voteFeedMeal(clara.id, borisMeal.id, true);

    const lb = await weeklyLeaderboard(now, anna.id);
    expect(lb.weekKey).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(mondayMsk(now)));
    expect(lb.rows.map((r) => `${r.name}:${r.likes}:${r.rank}`)).toEqual(["Борис:2:1", "Анна:1:2"]);
    expect(lb.me).toMatchObject({ isMe: true, rank: 2 });
    expect(lb.toNextRank).toBe(1);
  });

  it("лайки прошлой недели не считаются", async () => {
    const meal = await makeMeal(anna.id);
    await publishMeal(meal.id, anna.id);
    await voteFeedMeal(boris.id, meal.id, true);
    await prisma.feedVote.updateMany({ where: { mealId: meal.id }, data: { createdAt: new Date(mondayMsk(now).getTime() - 86_400_000) } });

    expect((await weeklyLeaderboard(now, anna.id)).rows).toEqual([]);
  });

  it("снятое с публикации уходит из ленты и из таблицы, голоса остаются", async () => {
    const meal = await makeMeal(anna.id);
    await publishMeal(meal.id, anna.id);
    await voteFeedMeal(boris.id, meal.id, true);

    expect(await unpublishMeal(meal.id, anna.id)).toBe(true);
    expect(await unpublishMeal(meal.id, anna.id)).toBe(false);
    expect(await feedBatch(boris.id)).toEqual([]);
    expect((await weeklyLeaderboard(now, anna.id)).rows).toEqual([]);
    expect(await prisma.feedVote.count({ where: { mealId: meal.id } })).toBe(1);
  });
});

describe("топ недели и своя статистика", () => {
  it("топ отдаёт самые залайканные блюда с автором", async () => {
    const meal = await makeMeal(anna.id, { dish: "борщ" });
    await publishMeal(meal.id, anna.id);
    await voteFeedMeal(boris.id, meal.id, true);
    await voteFeedMeal(clara.id, meal.id, true);

    const top = await topMealsOfWeek(now);
    expect(top[0]).toMatchObject({ dish: "борщ", authorName: "Анна", likes: 2 });
  });

  it("своя статистика не считает скрытые карточки", async () => {
    const visible = await makeMeal(anna.id);
    const hidden = await makeMeal(anna.id);
    await publishMeal(visible.id, anna.id);
    await publishMeal(hidden.id, anna.id);
    await voteFeedMeal(boris.id, visible.id, true);
    await voteFeedMeal(boris.id, hidden.id, true);
    await reportFeedMeal(boris.id, hidden.id);
    await reportFeedMeal(clara.id, hidden.id);

    expect(await myFeedStats(anna.id, now)).toEqual({ published: 1, likesThisWeek: 1 });
  });
});

describe("удаление аккаунта", () => {
  it("уносит голоса и жалобы каскадом", async () => {
    const meal = await makeMeal(anna.id);
    await publishMeal(meal.id, anna.id);
    await voteFeedMeal(boris.id, meal.id, true);
    await reportFeedMeal(boris.id, meal.id);

    await prisma.user.delete({ where: { id: boris.id } });
    expect(await prisma.feedVote.count({ where: { voterId: boris.id } })).toBe(0);
    expect(await prisma.feedReport.count({ where: { reporterId: boris.id } })).toBe(0);
  });
});
