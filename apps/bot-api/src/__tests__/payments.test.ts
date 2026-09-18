import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";

vi.mock("../services/subscription.js", () => ({ extendPro: vi.fn() }));
vi.mock("../services/users.js", () => ({ upsertUserFromTelegram: vi.fn().mockResolvedValue({ id: 42 }) }));

import { paywallKeyboard, registerPaymentHandlers, sendProInvoice } from "../bot/payments.js";
import { extendPro } from "../services/subscription.js";
import { upsertUserFromTelegram } from "../services/users.js";

// Capture the real registered handlers; mock only Telegram and persistence boundaries.
function handlers() {
  const bot = { on: vi.fn(), callbackQuery: vi.fn(), command: vi.fn() };
  registerPaymentHandlers(bot as unknown as Bot);
  return {
    on: (filter: string) => bot.on.mock.calls.find(([name]) => name === filter)![1],
    callback: bot.callbackQuery.mock.calls[0]![1],
    command: (name: string) => bot.command.mock.calls.find(([command]) => command === name)?.[1]
  };
}

beforeEach(() => vi.clearAllMocks());

describe("purchase pause bot", () => {
  it.each(["month", "year"] as const)("does not issue a %s invoice", async (plan) => {
    const ctx = { reply: vi.fn(), replyWithInvoice: vi.fn() };
    await sendProInvoice(ctx as unknown as Context, plan);
    expect(ctx.replyWithInvoice).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("недоступны"));
  });

  it.each(["month", "year"])("handles old pay:%s buttons without issuing an invoice", async (plan) => {
    const ctx = { match: [`pay:${plan}`, plan], answerCallbackQuery: vi.fn(), reply: vi.fn(), replyWithInvoice: vi.fn() };
    await handlers().callback(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(ctx.replyWithInvoice).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("недоступны"));
  });

  it.each(["pro_month", "pro_year", "legacy", ""])("rejects checkout for %j including old invoices", async (payload) => {
    const ctx = { preCheckoutQuery: { invoice_payload: payload }, answerPreCheckoutQuery: vi.fn() };
    await handlers().on("pre_checkout_query")(ctx);
    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.stringContaining("недоступны"));
    expect(extendPro).not.toHaveBeenCalled();
  });

  it("offers only a status link, without prices or pay callbacks", () => {
    expect(paywallKeyboard().inline_keyboard).toEqual([
      [{ text: "Статус подписки", web_app: { url: "https://example.com?screen=subscription" } }]
    ]);
  });

  it("answers /pro with purchase availability and a status link", async () => {
    const handler = handlers().command("pro");
    expect(handler).toBeTypeOf("function");
    const ctx = { reply: vi.fn(), replyWithInvoice: vi.fn() };
    await handler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("недоступны"), { reply_markup: paywallKeyboard() });
    expect(ctx.replyWithInvoice).not.toHaveBeenCalled();
  });

  it.each([["pro_month", 30], ["pro_year", 365]] as const)("still reconciles successful %s payments", async (payload, days) => {
    const ctx = {
      from: { id: 123 },
      message: { successful_payment: { invoice_payload: payload, telegram_payment_charge_id: "paid-before-pause" } },
      reply: vi.fn()
    };
    await handlers().on("message:successful_payment")(ctx);
    expect(upsertUserFromTelegram).toHaveBeenCalledWith(ctx.from);
    expect(extendPro).toHaveBeenCalledWith(42, days, "paid-before-pause");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Pro активирован"));
  });
});
