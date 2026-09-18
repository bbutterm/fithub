import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../bot/bot.js", () => ({ bot: { api: { createInvoiceLink: vi.fn().mockResolvedValue("https://t.me/invoice") } } }));
vi.mock("../lib/ai.js", () => ({ probeProvidersOnce: vi.fn() }));
vi.mock("../db.js", () => ({ prisma: {}, enableRls: vi.fn() }));

import { buildServer } from "../api/server.js";
import { bot } from "../bot/bot.js";

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
afterEach(async () => {
  await app?.close();
  vi.clearAllMocks();
});

describe("purchase pause API", () => {
  it.each([{ plan: "month" }, { plan: "year" }, { plan: "legacy" }, {}])(
    "refuses invoice request %j before calling Telegram",
    async (payload) => {
      app = await buildServer();
      const response = await app.inject({
        method: "POST",
        url: "/api/subscription/invoice",
        headers: { authorization: `Bearer ${app.jwt.sign({ uid: 1 })}` },
        payload
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "purchases_unavailable" });
      expect(bot.api.createInvoiceLink).not.toHaveBeenCalled();
    }
  );

  it("keeps authentication on the invoice endpoint", async () => {
    app = await buildServer();
    const response = await app.inject({ method: "POST", url: "/api/subscription/invoice", payload: { plan: "month" } });
    expect(response.statusCode).toBe(401);
    expect(bot.api.createInvoiceLink).not.toHaveBeenCalled();
  });
});
