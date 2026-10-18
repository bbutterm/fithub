import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { validateInitData } from "../../auth/initData.js";
import { getPlan } from "../../services/subscription.js";
import { upsertUserFromTelegram } from "../../services/users.js";
import { isAdminTgId } from "../admin.js";
import { serializeProfile } from "../serializers.js";

/** Вход Mini App: подпись Telegram меняется на сессионный токен. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // --- Auth ---
  app.post("/api/auth/telegram", async (request, reply) => {
    const body = z.object({ initData: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const validated = validateInitData(body.data.initData, config.BOT_TOKEN);
    if (!validated) return reply.code(401).send({ error: "invalid_init_data" });

    const user = await upsertUserFromTelegram(validated.user);
    const token = app.jwt.sign({ uid: user.id });
    // Возвращаем сразу всё, что нужно для старта Mini App — экономим roundtrip к /api/me
    const [profile, plan] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: user.id } }),
      getPlan(user.id)
    ]);
    return {
      token,
      user: { id: user.id, firstName: user.firstName, tz: user.tz },
      hasProfile: Boolean(profile),
      profile: profile ? serializeProfile(profile) : null,
      plan,
      isAdmin: isAdminTgId(user.tgUserId)
    };
  });
}
