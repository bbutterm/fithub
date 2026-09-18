/**
 * Смоук обработчиков бота: настоящие апдейты Telegram через bot.handleUpdate
 * на настоящей базе. Наружу не ходим — вызовы Bot API перехвачены, всё
 * остальное работает как в проде.
 *
 * Юнит-тесты проверяют чистые функции, а этот скрипт — то, что между ними:
 * команды, callback-кнопки, запись в базу, тексты и наборы кнопок.
 *
 * Запуск на ОДНОРАЗОВОЙ базе (не на боевой — скрипт создаёт и удаляет данные):
 *
 *   createdb bote2e
 *   for f in prisma/migrations./*\/migration.sql; do psql -d bote2e -f "$f"; done
 *   DATABASE_URL=postgresql://localhost/bote2e BOT_TOKEN=0:test WEBAPP_URL=https://example.invalid \
 *   VISION_API_KEY=test-key TEXT_API_KEY=test-key CRON_SECRET=test \
 *     pnpm exec tsx scripts/smoke-bot.ts
 */
import type { Update } from "grammy/types";
import { bot } from "../src/bot/bot.js";
import { prisma } from "../src/db.js";

const CHAT = 4242;
const TG_USER = { id: 4242, is_bot: false, first_name: "Тест", username: "tester" };

const sent: Array<{ method: string; text?: string; buttons: string[] }> = [];
let msgId = 1000;

function buttonsOf(payload: Record<string, unknown>): string[] {
  const rm = payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined;
  return (rm?.inline_keyboard ?? []).flat().map((b) => b.text);
}

bot.api.config.use(async (_prev, method, payload) => {
  const p = payload as Record<string, unknown>;
  if (method === "getMe") {
    return { ok: true, result: { ...TG_USER, is_bot: true, username: "Fithub_ai_bot" } } as never;
  }
  if (method === "sendMessage" || method === "editMessageText") {
    sent.push({ method, text: String(p.text ?? ""), buttons: buttonsOf(p) });
    return { ok: true, result: { message_id: ++msgId, date: 0, chat: { id: CHAT, type: "private" }, text: p.text } } as never;
  }
  if (method === "answerCallbackQuery") {
    sent.push({ method, text: String(p.text ?? ""), buttons: [] });
    return { ok: true, result: true } as never;
  }
  sent.push({ method, buttons: [] });
  return { ok: true, result: true } as never;
});

let updateId = 1;
// grammY распознаёт команды по entities, а не по тексту — как это делает Telegram
const msg = (text: string): Update => {
  const cmd = text.startsWith("/") ? (text.split(" ")[0] ?? "").length : 0;
  return {
    update_id: updateId++,
    message: {
      message_id: ++msgId, date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "private" }, from: TG_USER, text,
      ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd }] } : {})
    }
  } as Update;
};
const cb = (data: string): Update => ({
  update_id: updateId++,
  callback_query: {
    id: String(updateId), from: TG_USER, chat_instance: "x", data,
    message: { message_id: ++msgId, date: 0, chat: { id: CHAT, type: "private" }, text: "…" }
  }
}) as Update;

function last(n = 1) { return sent.slice(-n); }
function show(label: string) {
  const l = last(3).filter((s) => s.text);
  console.log(`\n▸ ${label}`);
  for (const s of l) {
    console.log(`   [${s.method}] ${(s.text ?? "").replace(/\n/g, " ⏎ ").slice(0, 150)}`);
    if (s.buttons.length) console.log(`   кнопки: ${s.buttons.join(" | ")}`);
  }
}

async function main() {
  await bot.init();
  await prisma.user.deleteMany({ where: { tgUserId: BigInt(TG_USER.id) } });

  await bot.handleUpdate(msg("/start"));
  show("/start");

  const user = await prisma.user.findUniqueOrThrow({ where: { tgUserId: BigInt(TG_USER.id) } });
  await prisma.profile.create({
    data: { userId: user.id, gender: "male", weightKg: 80, heightCm: 180, birthYear: 1990,
            targetKcal: 2000, targetProtein: 120, targetFat: 65, targetCarbs: 220, updatedAt: new Date() }
  });

  sent.length = 0;
  await bot.handleUpdate(msg("/food"));
  show("/food (блюд ещё нет)");

  // Приём пищи, как его создаёт распознавание
  const meal = await prisma.meal.create({
    data: { userId: user.id, source: "photo", totalKcal: 520, totalProtein: 48, totalFat: 11, totalCarbs: 58,
      items: { create: [
        { dish: "куриная грудка", grams: 180, kcal: 300, protein: 40, fat: 6, carbs: 2, confidence: 0.9 },
        { dish: "рис отварной", grams: 170, kcal: 220, protein: 8, fat: 5, carbs: 56, confidence: 0.9 }] } },
    include: { items: true }
  });

  sent.length = 0;
  await bot.handleUpdate(cb(`meal:save:${meal.id}`));
  show("кнопка «💾 В мои блюда»");
  const recipes = await prisma.recipe.findMany({ where: { userId: user.id } });
  console.log("   → в базе блюд:", recipes.map((r) => `${r.name} (${Math.round(r.kcal)} ккал, ${Math.round(r.portionGrams)} г)`).join("; "));

  sent.length = 0;
  await bot.handleUpdate(msg("/food"));
  show("/food (блюдо есть)");

  const rid = recipes[0]!.id;
  sent.length = 0;
  await bot.handleUpdate(cb(`rcp:p:${rid}`));
  show("выбор блюда → порции");

  sent.length = 0;
  await bot.handleUpdate(cb(`rcp:u:${rid}:5`));
  show("записать половину порции");
  const logged = await prisma.meal.findFirst({ where: { userId: user.id, source: "manual" }, include: { items: true } });
  console.log("   → записано:", logged ? `${Math.round(logged.totalKcal)} ккал, позиций ${logged.items.length}` : "НИЧЕГО");
  console.log("   → счётчик использований:", (await prisma.recipe.findUniqueOrThrow({ where: { id: rid } })).timesUsed);
  const counter = await prisma.usageCounter.findFirst({ where: { userId: user.id } });
  console.log("   → лимит распознаваний израсходован:", counter ? `ДА (${counter.photoCount})` : "нет — как и задумано");

  sent.length = 0;
  await bot.handleUpdate(msg("/challenge"));
  show("/challenge (нет активного)");

  sent.length = 0;
  await bot.handleUpdate(cb("ch:t:protein7"));
  show("выбор шаблона «Белок 7 дней» → проверка выполнимости");

  sent.length = 0;
  await bot.handleUpdate(cb("ch:s:protein7:0"));
  show("старт челленджа");
  const ch = await prisma.challenge.findFirst({ where: { ownerId: user.id } });
  console.log("   → челлендж:", ch ? `${ch.title}, старт ${ch.startDate}, код ${ch.joinCode}` : "НЕ СОЗДАН");

  sent.length = 0;
  await bot.handleUpdate(msg("/challenge"));
  show("/challenge (активный)");

  sent.length = 0;
  await bot.handleUpdate(cb("ch:s:protein7:0"));
  show("попытка начать второй челлендж");

  // Вступление по ссылке другим человеком
  const friend = { id: 5353, is_bot: false, first_name: "Друг" };
  await prisma.user.deleteMany({ where: { tgUserId: BigInt(friend.id) } });
  sent.length = 0;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: ++msgId, date: 0, chat: { id: 5353, type: "private" }, from: friend,
               text: `/start ch_${ch!.joinCode}`, entities: [{ type: "bot_command", offset: 0, length: 6 }] }
  } as Update);
  show("друг открыл ссылку-приглашение");
  console.log("   → участников:", await prisma.challengeParticipant.count({ where: { challengeId: ch!.id } }));

  sent.length = 0;
  await bot.handleUpdate(msg("/delete"));
  show("/delete");
  sent.length = 0;
  await bot.handleUpdate(cb("acct:del:yes"));
  show("подтверждение удаления");
  console.log("   → пользователь в базе:", await prisma.user.count({ where: { tgUserId: BigInt(TG_USER.id) } }));

  await prisma.user.deleteMany({ where: { tgUserId: { in: [BigInt(TG_USER.id), BigInt(friend.id)] } } });
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("ОШИБКА:", e); await prisma.$disconnect(); process.exit(1); });
