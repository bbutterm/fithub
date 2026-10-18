import { Composer, type Context } from "grammy";
import { getRecipeForUser, listRecipes, logRecipe } from "../../services/recipes.js";
import { upsertUserFromTelegram } from "../../services/users.js";
import { portionKeyboard, recipeListKeyboard } from "../keyboards.js";
import { publishMealCard } from "../mealCard.js";

/** «Мои блюда»: запись привычной еды без фото и без вызовов модели. */
export const recipesComposer = new Composer<Context>();

/** Список сохранённых блюд. Повтор отсюда не стоит ни одного вызова ИИ. */
async function showRecipeList(ctx: Context, userId: number, edit: boolean): Promise<void> {
  const recipes = await listRecipes(userId, 8);
  if (recipes.length === 0) {
    const text =
      "Сохранённых блюд пока нет.\n\n" +
      "Пришлите фото еды, и под карточкой будет кнопка <b>💾 В мои блюда</b>. " +
      "Потом такое же блюдо записывается одним тапом — без фото и мгновенно.";
    if (edit) await ctx.editMessageText(text, { parse_mode: "HTML" }).catch(() => undefined);
    else await ctx.reply(text, { parse_mode: "HTML" });
    return;
  }
  const text = "🍲 <b>Мои блюда</b>\n\nВыберите — запишу в дневник без фото и распознавания.";
  const markup = recipeListKeyboard(recipes);
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: markup }).catch(() => undefined);
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
}

recipesComposer.command("food", async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  await showRecipeList(ctx, user.id, false);
});

recipesComposer.callbackQuery("rcp:list", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  const user = await upsertUserFromTelegram(ctx.from);
  await showRecipeList(ctx, user.id, true);
});

recipesComposer.callbackQuery(/^rcp:p:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const recipe = await getRecipeForUser(Number(ctx.match[1]), user.id);
  if (!recipe) {
    await ctx.answerCallbackQuery({ text: "Блюдо не найдено" });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx
    .editMessageText(
      `🍲 <b>${recipe.name}</b>\n\nПорция ${Math.round(recipe.portionGrams)} г · ${Math.round(recipe.kcal)} ккал ` +
        `(Б ${Math.round(recipe.protein)} / Ж ${Math.round(recipe.fat)} / У ${Math.round(recipe.carbs)})\n\nСколько съели?`,
      { parse_mode: "HTML", reply_markup: portionKeyboard(recipe.id) }
    )
    .catch(() => undefined);
});

recipesComposer.callbackQuery(/^rcp:u:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.from || !ctx.chat) return;
  const user = await upsertUserFromTelegram(ctx.from);
  const recipe = await getRecipeForUser(Number(ctx.match[1]), user.id);
  if (!recipe) {
    await ctx.answerCallbackQuery({ text: "Блюдо не найдено" });
    return;
  }
  const multiplier = Number(ctx.match[2]) / 10;
  await ctx.answerCallbackQuery({ text: "Записываю…" });
  // Лимит распознаваний не расходуется: вызова модели здесь нет, платить не за что
  const meal = await logRecipe(recipe, multiplier);
  const messageId = ctx.callbackQuery.message?.message_id;
  if (messageId) await publishMealCard(ctx, user, meal, messageId);
});


