import type { User } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";

export interface TgUserLike {
  id: number | bigint;
  first_name?: string;
  username?: string;
}

export async function upsertUserFromTelegram(tg: TgUserLike): Promise<User> {
  const tgUserId = BigInt(tg.id);
  return prisma.user.upsert({
    where: { tgUserId },
    create: {
      tgUserId,
      firstName: tg.first_name ?? null,
      username: tg.username ?? null,
      tz: config.TZ_DEFAULT
    },
    update: {
      firstName: tg.first_name ?? null,
      username: tg.username ?? null
    }
  });
}
