import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bot/bot.js", () => ({ bot: { api: { sendMessage: vi.fn() } } }));
vi.mock("../services/subscription.js", () => ({ expireSubscriptions: vi.fn(), extendPro: vi.fn() }));

import { runSubscriptionExpiryTick } from "../cron/subscriptions.js";
import { expireSubscriptions } from "../services/subscription.js";
import { bot } from "../bot/bot.js";
import { paywallKeyboard } from "../bot/payments.js";

beforeEach(() => vi.clearAllMocks());

describe("expiry notices during purchase pause", () => {
  it("still expires subscriptions but does not offer renewal or payment buttons", async () => {
    vi.mocked(expireSubscriptions).mockResolvedValue([
      { userId: 42, user: { tgUserId: 123n } }
    ] as Awaited<ReturnType<typeof expireSubscriptions>>);
    await runSubscriptionExpiryTick();
    expect(expireSubscriptions).toHaveBeenCalledOnce();
    expect(bot.api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("недоступны"), { reply_markup: paywallKeyboard() });
    const text = vi.mocked(bot.api.sendMessage).mock.calls[0]![1];
    expect(text).not.toMatch(/один тап|Stars|купить/i);
  });
});
