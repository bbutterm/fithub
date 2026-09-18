import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Grammy from "grammy";

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof Grammy>();
  return { ...actual, Bot: class {
    command = vi.fn();
    callbackQuery = vi.fn();
    on = vi.fn();
    catch = vi.fn();
  } };
});
vi.mock("../db.js", () => ({ prisma: { meal: { findFirst: vi.fn().mockResolvedValue(null) } } }));
vi.mock("../services/users.js", () => ({ upsertUserFromTelegram: vi.fn().mockResolvedValue({ id: 42 }) }));
vi.mock("../services/limits.js", () => ({
  checkBurstLimit: vi.fn().mockResolvedValue(true),
  checkRecognitionLimit: vi.fn().mockResolvedValue({ allowed: false, limit: 7 }),
  tryConsumeRecognition: vi.fn().mockResolvedValue({ allowed: false, limit: 7 }),
  refundRecognition: vi.fn()
}));
vi.mock("../bot/queue.js", () => ({ checkRateLimit: vi.fn().mockReturnValue(true) }));
vi.mock("../services/locks.js", () => ({ acquireRecognitionLock: vi.fn().mockResolvedValue(true), releaseRecognitionLock: vi.fn() }));
vi.mock("../ai/food.js", () => ({ interpretUserText: vi.fn().mockResolvedValue({ action: "new_meal", items: [{}] }) }));

import { bot } from "../bot/bot.js";
import { prisma } from "../db.js";
import { paywallKeyboard } from "../bot/payments.js";

// Preserve registration calls; individual contexts get fresh Telegram mocks.
beforeEach(() => { vi.mocked(prisma.meal.findFirst).mockResolvedValue(null); });

async function dispatch(filter: string, message: Record<string, unknown>) {
  const call = vi.mocked(bot.on).mock.calls.find(([name]) => name === filter)!;
  const handler = call[1] as unknown as (ctx: unknown) => Promise<void>;
  const ctx = {
    from: { id: 123 }, chat: { id: 123 }, message,
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    api: { editMessageText: vi.fn().mockResolvedValue({}) }
  };
  await handler(ctx);
  return ctx;
}

describe("limit paywall copy", () => {
  it.each([
    ["message:photo", { photo: [{ file_id: "photo", width: 320, height: 320 }] }],
    ["message:text", { text: "Овсянка на завтрак" }],
    ["message:voice", { voice: { file_id: "voice", duration: 10 } }]
  ] as const)("explains the pause and tomorrow's limit for %s", async (filter, message) => {
    const ctx = await dispatch(filter, message);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("недоступны"), {
      parse_mode: "HTML", reply_markup: paywallKeyboard()
    });
    const text = ctx.reply.mock.calls[0]![0] as string;
    expect(text).toContain("7");
    expect(text).toContain("завтра");
    expect(text).not.toMatch(/безлимит|Stars|купить/i);
  });

  it("uses the same non-selling copy for a contextual new meal", async () => {
    vi.mocked(prisma.meal.findFirst).mockResolvedValue({
      id: 1, eatenAt: new Date(), tgMessageId: null, items: [{ dish: "Рис" }]
    } as unknown as NonNullable<Awaited<ReturnType<typeof prisma.meal.findFirst>>>);
    const ctx = await dispatch("message:text", { text: "Ещё съел банан" });
    expect(ctx.api.editMessageText).toHaveBeenCalledWith(123, 1, expect.stringContaining("недоступны"), { reply_markup: paywallKeyboard() });
    expect(ctx.api.editMessageText.mock.calls[0]![2]).toContain("завтра");
  });
});
