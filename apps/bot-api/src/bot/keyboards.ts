import { InlineKeyboard } from "grammy";
import { CHALLENGE_TEMPLATES } from "../challenges.js";
import { config } from "../config.js";

/**
 * Клавиатуры под сообщениями бота.
 *
 * Собраны в одном месте, потому что одни и те же кнопки появляются из разных
 * обработчиков: карточка приёма рисуется и после фото, и после «записать» из
 * проверки, и после кнопки напоминания.
 */
export function mealKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard()
    .webApp("✏️ Поправить", `${config.WEBAPP_URL}?meal=${mealId}`)
    .text("🗑 Удалить", `meal:del:${mealId}`)
    .row()
    .text("🕐 Время", `meal:time:${mealId}`)
    // Сохранение прямо здесь, а не отдельной формой: ИИ уже разобрал состав,
    // человеку остаётся один тап
    .text("💾 В мои блюда", `meal:save:${mealId}`)
    .row()
    .webApp("📊 Дневник", config.WEBAPP_URL);
}

/** Выбор порции: без множителя сохранённые блюда бесполезны — порции разные. */
export function portionKeyboard(recipeId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("½ порции", `rcp:u:${recipeId}:5`)
    .text("1 порция", `rcp:u:${recipeId}:10`)
    .row()
    .text("1½", `rcp:u:${recipeId}:15`)
    .text("2 порции", `rcp:u:${recipeId}:20`)
    .row()
    .text("↩️ К списку", "rcp:list");
}

export function recipeListKeyboard(recipes: Array<{ id: number; name: string; kcal: number }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of recipes) {
    kb.text(`${r.name} · ${Math.round(r.kcal)} ккал`, `rcp:p:${r.id}`).row();
  }
  return kb.webApp("📊 Дневник", config.WEBAPP_URL);
}

// Быстрый выбор времени приёма: сдвиги от «сейчас» и типовые часы (локальное время юзера)
export function timeKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("−30 мин", `meal:ts:${mealId}:m30`)
    .text("−1 ч", `meal:ts:${mealId}:m60`)
    .text("−2 ч", `meal:ts:${mealId}:m120`)
    .text("−3 ч", `meal:ts:${mealId}:m180`)
    .row()
    .text("Утро 8:00", `meal:ts:${mealId}:p08:00`)
    .text("Обед 13:00", `meal:ts:${mealId}:p13:00`)
    .text("Ужин 19:00", `meal:ts:${mealId}:p19:00`)
    .row()
    .text("↩️ Назад", `meal:tb:${mealId}`);
}


export function checkKeyboard(checkId: number): InlineKeyboard {
  return new InlineKeyboard().text("📝 Всё-таки записать", `chk:log:${checkId}`);
}


export function templatesKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of CHALLENGE_TEMPLATES) kb.text(t.title, `ch:t:${t.id}`).row();
  return kb;
}

