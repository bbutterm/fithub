/**
 * Смоук трёх сценариев удержания на настоящей базе и настоящих обработчиках:
 *   1) режим «можно?» — проверка без записи и кнопка «всё-таки записать»;
 *   2) вечернее напоминание и кнопки под ним («ел как обычно», «не напоминать»);
 *   3) (косвенно) подсказка «что дальше» под карточкой — зависит от часа, поэтому
 *      здесь только не падает; правило покрыто юнит-тестом nextStep.test.ts.
 *
 * Bot API и вызовы модели подменены, наружу ничего не уходит. База одноразовая:
 *
 *   DATABASE_URL=postgresql://localhost/bote2e BOT_TOKEN=0:test WEBAPP_URL=https://example.invalid \
 *   VISION_API_KEY=test-key TEXT_API_KEY=test-key CRON_SECRET=test \
 *     pnpm exec tsx scripts/smoke-retention.ts
 */
import type { Update } from "grammy/types";
import { bot } from "../src/bot/bot.js";
import { prisma } from "../src/db.js";
import { textClient, type ChatMessage } from "../src/lib/ai.js";
import { runReminderTick } from "../src/cron/reminders.js";

const CHAT = 4343;
const TG_USER = { id: 4343, is_bot: false, first_name: "Ретеншн", username: "retention" };

const sent: Array<{ method: string; text?: string; buttons: string[]; data: string[] }> = [];
let msgId = 2000;
function keyboardOf(payload: Record<string, unknown>) {
  const rm = payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } | undefined;
  const flat = (rm?.inline_keyboard ?? []).flat();
  return { buttons: flat.map((b) => b.text), data: flat.map((b) => b.callback_data ?? "") };
}
bot.api.config.use(async (_prev, method, payload) => {
  const p = payload as Record<string, unknown>;
  if (method === "getMe") return { ok: true, result: { ...TG_USER, is_bot: true, username: "Fithub_ai_bot" } } as never;
  if (method === "sendMessage" || method === "editMessageText") {
    sent.push({ method, text: String(p.text ?? ""), ...keyboardOf(p) });
    return { ok: true, result: { message_id: ++msgId, date: 0, chat: { id: CHAT, type: "private" }, text: p.text } } as never;
  }
  if (method === "answerCallbackQuery") {
    sent.push({ method, text: String(p.text ?? ""), buttons: [], data: [] });
    return { ok: true, result: true } as never;
  }
  sent.push({ method, buttons: [], data: [] });
  return { ok: true, result: true } as never;
});

// Модель: по системному промпту понимаем, что от неё хотят
const calls: string[] = [];
textClient.chatCompletion = async (messages: ChatMessage[]) => {
  const system = String(messages[0]?.content ?? "");
  const purpose = system.includes('"verdict"') ? "diet" : system.includes("Пользователь опи") ? "text_meal" : "other";
  calls.push(purpose);
  const text =
    purpose === "diet"
      ? JSON.stringify({ verdict: "avoid", note: "Жареный картофель по столу №5 не подходит — тот же картофель отварной или запечённый можно." })
      : purpose === "text_meal"
        ? JSON.stringify({ items: [{ dish: "картофель жареный", grams: 200, kcal: 380, protein: 6, fat: 18, carbs: 48, confidence: 0.8 }], overall_confidence: 0.8 })
        : "stub";
  return { text, usage: { promptTokens: 1, completionTokens: 1 }, costUsd: 0, latencyMs: 1, model: "stub" };
};

let updateId = 1;
const msg = (text: string): Update => {
  const cmd = text.startsWith("/") ? (text.split(" ")[0] ?? "").length : 0;
  return { update_id: updateId++, message: { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" }, from: TG_USER, text,
    ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd }] } : {}) } } as Update;
};
const cb = (data: string): Update => ({ update_id: updateId++, callback_query: { id: String(updateId), from: TG_USER, chat_instance: "x", data,
  message: { message_id: ++msgId, date: 0, chat: { id: CHAT, type: "private" }, text: "…" } } }) as Update;

let failures = 0;
function expect(label: string, ok: boolean, detail = "") {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function lastText() { return [...sent].reverse().find((s) => s.text)?.text ?? ""; }
function show(label: string) {
  console.log(`\n▸ ${label}`);
  for (const s of sent.slice(-3).filter((s) => s.text)) {
    console.log(`   [${s.method}] ${(s.text ?? "").replace(/\n/g, " ⏎ ").slice(0, 160)}`);
    if (s.buttons.length) console.log(`   кнопки: ${s.buttons.join(" | ")}`);
  }
}
/** 21:00 по Москве заданного дня (UTC 18:00) — час, в который стреляет крон. */
const mskEvening = (isoDate: string) => new Date(`${isoDate}T18:00:00Z`);
const mskDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function main() {
  await bot.init();
  await prisma.user.deleteMany({ where: { tgUserId: BigInt(TG_USER.id) } });

  await bot.handleUpdate(msg("/start"));
  expect("/start рассказывает про «можно?»", lastText().includes("можно?"));
  const user = await prisma.user.findUniqueOrThrow({ where: { tgUserId: BigInt(TG_USER.id) } });
  await prisma.profile.create({ data: { userId: user.id, gender: "male", weightKg: 80, heightCm: 180, birthYear: 1990,
    targetKcal: 2000, targetProtein: 120, targetFat: 65, targetCarbs: 220, medicalDiets: ["table5"], updatedAt: new Date() } });

  // 1. Режим «можно?»
  sent.length = 0; calls.length = 0;
  await bot.handleUpdate(msg("можно мне жареную картошку?"));
  show("«можно мне жареную картошку?»");
  const card = lastText();
  expect("карточка проверки, не записи", card.startsWith("🔎") && card.includes("не записано"));
  expect("вердикт по столу №5 на месте", card.includes("🚫") && card.includes("отварной"));
  expect("модель звали дважды: еда + режим", calls.join(",") === "text_meal,diet", calls.join(","));
  const kb = sent[sent.length - 1]!;
  expect("кнопка «всё-таки записать»", kb.buttons.some((b) => b.includes("записать")));
  expect("приём в дневник НЕ создан", (await prisma.meal.count({ where: { userId: user.id } })) === 0);
  expect("проверка сохранена", (await prisma.quickCheck.count({ where: { userId: user.id } })) === 1);
  const counter = await prisma.usageCounter.findFirst({ where: { userId: user.id } });
  expect("попытка распознавания списана", counter?.photoCount === 1, `photoCount=${counter?.photoCount}`);

  const logData = kb.data.find((d) => d.startsWith("chk:log:"))!;
  sent.length = 0; calls.length = 0;
  await bot.handleUpdate(cb(logData));
  show("кнопка «всё-таки записать»");
  const meal = await prisma.meal.findFirst({ where: { userId: user.id }, include: { items: true } });
  expect("приём создан без второго вызова модели", Boolean(meal) && calls.length === 0, `calls=${calls.join(",")}`);
  expect("вердикт перенесён в запись", meal?.dietVerdict === "avoid");
  expect("карточка стала обычной записью", lastText().includes("Записал приём пищи"));
  expect("проверка удалена", (await prisma.quickCheck.count({ where: { userId: user.id } })) === 0);
  sent.length = 0;
  await bot.handleUpdate(cb(logData));
  expect("повторное нажатие — «устарела»", sent.some((s) => s.text?.includes("устарела")));

  // Вопрос без сильного слова рядом с недавней записью — это уточнение, не проверка
  sent.length = 0; calls.length = 0;
  await bot.handleUpdate(msg("там точно 200 грамм?"));
  expect("«?» рядом с записью не уводит в проверку", !calls.includes("diet") && !lastText().startsWith("🔎"), `calls=${calls.join(",")}`);

  // 2. Вечернее напоминание
  await prisma.meal.deleteMany({ where: { userId: user.id } });
  const now = mskEvening("2026-09-19");
  const today = mskDate(now);
  await prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(now.getTime() - 30 * 86_400_000) } });
  sent.length = 0;
  await runReminderTick(now);
  expect("давно неактивному (без записей, месяц в боте) не шлём", sent.length === 0);

  // Две записи в прошлые дни → «живой», и есть из чего считать среднее
  for (const [daysAgo, kcal, protein] of [[2, 1800, 100], [3, 2200, 120]] as const) {
    await prisma.meal.create({ data: { userId: user.id, source: "photo", eatenAt: new Date(now.getTime() - daysAgo * 86_400_000 - 6 * 3_600_000),
      totalKcal: kcal, totalProtein: protein, totalFat: 60, totalCarbs: 200,
      items: { create: [{ dish: "обед", grams: 400, kcal, protein, fat: 60, carbs: 200, confidence: 0.9 }] } } });
  }
  sent.length = 0;
  await runReminderTick(now);
  show("крон вечером, день пустой");
  expect("напоминание ушло с тремя кнопками", lastText().includes("дневнике пусто") && sent[sent.length - 1]!.buttons.length === 3);
  expect("дата отмечена", (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastReminderDate === today);
  sent.length = 0;
  await runReminderTick(now);
  expect("повторный тик в тот же день — тишина", sent.length === 0);
  sent.length = 0;
  await runReminderTick(mskEvening("2026-09-20"));
  expect("на следующий день — снова (день опять пуст)", sent.length > 0);
  await prisma.user.update({ where: { id: user.id }, data: { lastReminderDate: null } });
  sent.length = 0;
  await runReminderTick(new Date("2026-09-19T09:00:00Z"));
  expect("днём (12:00 МСК) не шлём", sent.length === 0);

  sent.length = 0;
  await bot.handleUpdate(cb("rem:usual"));
  show("кнопка «ел как обычно»");
  const usual = await prisma.meal.findFirst({ where: { userId: user.id, source: "manual" }, include: { items: true } });
  expect("создана запись по среднему", Boolean(usual) && usual!.items[0]!.dish.startsWith("Обычный день"));
  expect("среднее посчитано верно (2000 ккал, 110 г белка)", Math.round(usual?.totalKcal ?? 0) === 2000 && Math.round(usual?.totalProtein ?? 0) === 110,
    `${usual?.totalKcal}/${usual?.totalProtein}`);
  expect("карточка отправлена", sent.some((s) => s.text?.includes("Записал приём пищи")));
  sent.length = 0;
  await bot.handleUpdate(cb("rem:usual"));
  expect("второе нажатие — «уже есть записи»", sent.some((s) => s.text?.includes("уже есть записи")));

  sent.length = 0;
  await bot.handleUpdate(cb("rem:off"));
  const prof = await prisma.profile.findUniqueOrThrow({ where: { userId: user.id } });
  expect("«не напоминать» выключает флаг", prof.reminderEnabled === false);
  await prisma.meal.deleteMany({ where: { userId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { lastReminderDate: null } });
  sent.length = 0;
  await runReminderTick(now);
  expect("выключенному не шлём", sent.length === 0);

  await prisma.user.deleteMany({ where: { tgUserId: BigInt(TG_USER.id) } });
  await prisma.$disconnect();
  console.log(failures ? `\n✗ провалов: ${failures}` : "\n✓ все проверки прошли");
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error("ОШИБКА:", e); await prisma.$disconnect(); process.exit(1); });
