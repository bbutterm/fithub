import { InlineKeyboard } from "grammy";

// Вынесено из cron/reminders.ts, чтобы бот не импортировал крон (крон импортирует бота).

export const REMINDER_TEXT =
  "🌙 Сегодня в дневнике пусто.\n\nЕсли день был обычным — жми кнопку, запишу по твоему среднему. Если нет — пришли фото или опиши ужин текстом, это десять секунд.";

export function reminderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🍽 Ел как обычно", "rem:usual")
    .text("📷 Сейчас пришлю", "rem:later")
    .row()
    .text("🔕 Не напоминать", "rem:off");
}
