/**
 * Смоук общей ленты еды на настоящей базе: публикация, свайпы, жалобы,
 * недельный лидерборд. Наружу не ходим — сервис в базу, и только.
 *
 * Запуск на ОДНОРАЗОВОЙ базе:
 *
 *   DATABASE_URL=postgresql://localhost/bote2e BOT_TOKEN=0:test WEBAPP_URL=https://example.invalid \
 *   VISION_API_KEY=test-key TEXT_API_KEY=test-key CRON_SECRET=test \
 *     pnpm exec tsx scripts/smoke-feed.ts
 */
import { prisma } from "../src/db.js";
import {
  autoPublishIfOptedIn, feedBatch, isMealInFeed, myFeedStats, publishMeal,
  reportFeedMeal, topMealsOfWeek, unpublishMeal, voteFeedMeal, weeklyLeaderboard
} from "../src/services/feed.js";

const IDS = [90001, 90002, 90003, 90004] as const;
let failures = 0;
function expect(label: string, ok: boolean, detail = "") {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function head(label: string) { console.log(`\n▸ ${label}`); }

async function mkUser(tgId: number, firstName: string) {
  return prisma.user.create({ data: { tgUserId: BigInt(tgId), firstName } });
}
async function mkMeal(userId: number, dish: string, kcal: number, withPhoto = true) {
  return prisma.meal.create({
    data: {
      userId, source: "photo", totalKcal: kcal, totalProtein: 30, totalFat: 20, totalCarbs: 50,
      photoFileId: withPhoto ? `file_${dish}` : null,
      items: { create: [{ dish, grams: 300, kcal, protein: 30, fat: 20, carbs: 50, confidence: 0.9 }] }
    }
  });
}

async function main() {
  await prisma.user.deleteMany({ where: { tgUserId: { in: IDS.map((i) => BigInt(i)) } } });
  const [anna, boris, clara] = await Promise.all([mkUser(IDS[0], "Анна"), mkUser(IDS[1], "Борис"), mkUser(IDS[2], "Клара")]);
  const now = new Date("2026-09-16T09:00:00Z"); // среда, 12:00 МСК

  head("Публикация");
  const borsch = await mkMeal(anna.id, "борщ", 450);
  const salad = await mkMeal(anna.id, "салат", 250);
  const noPhoto = await mkMeal(anna.id, "каша", 300, false);
  expect("без фото публиковать нечего", (await publishMeal(noPhoto.id, anna.id)) === "no_photo");
  expect("чужой приём не опубликовать", (await publishMeal(borsch.id, boris.id)) === "not_found");
  expect("публикация по кнопке", (await publishMeal(borsch.id, anna.id)) === "published");
  expect("повтор — «уже там»", (await publishMeal(borsch.id, anna.id)) === "already");
  await publishMeal(salad.id, anna.id);

  head("Автопубликация только по тумблеру");
  const kotleta = await mkMeal(boris.id, "котлета", 500);
  expect("без тумблера не публикуется", (await autoPublishIfOptedIn(kotleta.id, boris.id)) === false);
  await prisma.profile.create({ data: { userId: boris.id, feedOptIn: true, updatedAt: new Date() } });
  expect("с тумблером публикуется", (await autoPublishIfOptedIn(kotleta.id, boris.id)) === true);

  head("Лента");
  const forBoris = await feedBatch(boris.id);
  expect("видит только чужие опубликованные с фото", forBoris.map((c) => c.dish).sort().join(",") === "борщ,салат",
    forBoris.map((c) => c.dish).join(","));
  expect("имя автора на карточке", forBoris[0]?.authorName === "Анна");
  expect("своё в ленте не показывается", !forBoris.some((c) => c.authorId === boris.id));

  head("Голоса");
  const v1 = await voteFeedMeal(boris.id, borsch.id, true);
  expect("лайк засчитан", v1.ok && v1.counted && v1.likeCount === 1, JSON.stringify(v1));
  const v2 = await voteFeedMeal(boris.id, borsch.id, true);
  expect("повторный голос не накручивает", v2.ok && !v2.counted && v2.likeCount === 1, JSON.stringify(v2));
  const own = await voteFeedMeal(anna.id, borsch.id, true);
  expect("за своё голосовать нельзя", !own.ok && own.reason === "own_meal");
  await voteFeedMeal(clara.id, borsch.id, false); // скип
  const afterSkip = await prisma.meal.findUniqueOrThrow({ where: { id: borsch.id } });
  expect("скип считается оценкой, но не лайком", afterSkip.voteCount === 2 && afterSkip.likeCount === 1,
    `votes=${afterSkip.voteCount} likes=${afterSkip.likeCount}`);
  expect("оценённое больше не показывают", !(await feedBatch(boris.id)).some((c) => c.mealId === borsch.id));

  head("Порядок: неоценённым — приоритет, внутри — свежие");
  // Свежий зритель: у Клары борщ уже оценён и в её ленту не попадает
  const dima = await mkUser(IDS[3], "Дима");
  const order = await feedBatch(dima.id);
  expect("сначала неоценённые (котлета свежее салата), борщ с 2 оценками — последний",
    order.map((c) => c.dish).join(",") === "котлета,салат,борщ",
    order.map((c) => `${c.dish}:${c.voteCount}`).join(","));

  head("Жалобы");
  await prisma.user.delete({ where: { id: dima.id } }); // дальше он не участвует
  expect("одна жалоба не прячет", (await reportFeedMeal(boris.id, salad.id)).hidden === false);
  expect("повторная жалоба того же человека не считается", (await reportFeedMeal(boris.id, salad.id)).hidden === false);
  expect("две разные жалобы прячут", (await reportFeedMeal(clara.id, salad.id)).hidden === true);
  expect("скрытое исчезает из ленты", !(await feedBatch(clara.id)).some((c) => c.mealId === salad.id));
  expect("скрытое недоступно фото-прокси", (await isMealInFeed(salad.id)) === false);
  expect("опубликованное доступно фото-прокси", (await isMealInFeed(borsch.id)) === true);

  head("Лидерборд недели");
  await voteFeedMeal(anna.id, kotleta.id, true);
  await voteFeedMeal(clara.id, kotleta.id, true);
  const lb = await weeklyLeaderboard(now, anna.id);
  expect("неделя с понедельника", lb.weekKey === "2026-09-14", lb.weekKey);
  expect("Борис первый (2 лайка), Анна вторая (1)",
    lb.rows.map((r) => `${r.name}:${r.likes}:${r.rank}`).join(" ") === "Борис:2:1 Анна:1:2",
    lb.rows.map((r) => `${r.name}:${r.likes}:${r.rank}`).join(" "));
  expect("своё место отмечено", lb.me?.isMe === true && lb.me?.rank === 2);
  expect("до места выше — 1 лайк", lb.toNextRank === 1, String(lb.toNextRank));

  head("Прошлая неделя не засчитывается");
  await prisma.feedVote.updateMany({ where: { mealId: kotleta.id }, data: { createdAt: new Date("2026-09-10T09:00:00Z") } });
  const lb2 = await weeklyLeaderboard(now, anna.id);
  expect("старые лайки выпали из таблицы", lb2.rows.map((r) => r.name).join(",") === "Анна", lb2.rows.map((r) => r.name).join(","));

  head("Топ недели и своя статистика");
  const top = await topMealsOfWeek(now);
  expect("в топе борщ Анны", top[0]?.dish === "борщ" && top[0]?.authorName === "Анна" && top[0]?.likes === 1, JSON.stringify(top));
  const stats = await myFeedStats(anna.id, now);
  expect("опубликовано 1 (салат скрыт), лайков за неделю 1", stats.published === 1 && stats.likesThisWeek === 1, JSON.stringify(stats));

  head("Снятие с публикации");
  expect("снято", (await unpublishMeal(borsch.id, anna.id)) === true);
  expect("повтор — уже снято", (await unpublishMeal(borsch.id, anna.id)) === false);
  expect("исчезло из ленты", (await feedBatch(clara.id)).length === 0);
  expect("исчезло из лидерборда", (await weeklyLeaderboard(now, anna.id)).rows.length === 0);
  expect("голоса сохранились для возврата", (await prisma.feedVote.count({ where: { mealId: borsch.id } })) === 2);

  head("Удаление аккаунта уносит голоса");
  await prisma.user.delete({ where: { id: boris.id } });
  expect("голоса Бориса удалены каскадом", (await prisma.feedVote.count({ where: { voterId: boris.id } })) === 0);

  await prisma.user.deleteMany({ where: { tgUserId: { in: IDS.map((i) => BigInt(i)) } } });
  await prisma.$disconnect();
  console.log(failures ? `\n✗ провалов: ${failures}` : "\n✓ все проверки прошли");
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error("ОШИБКА:", e); await prisma.$disconnect(); process.exit(1); });
