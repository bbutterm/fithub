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

export interface AccountSummary {
  meals: number;
  advices: number;
  hasProfile: boolean;
  createdAt: Date;
}

/** Что именно исчезнет при удалении — показываем человеку до подтверждения. */
export async function summarizeAccount(userId: number): Promise<AccountSummary | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { _count: { select: { meals: true, advices: true } }, profile: { select: { userId: true } } }
  });
  if (!user) return null;
  return {
    meals: user._count.meals,
    advices: user._count.advices,
    hasProfile: Boolean(user.profile),
    createdAt: user.createdAt
  };
}

/**
 * Полное удаление аккаунта по требованию пользователя.
 *
 * В базе лежат вес, рост, аллергии и лечебные диеты — данные о здоровье, и
 * человек должен уметь убрать их одним действием, а не письмом владельцу.
 *
 * Связанные записи уходят каскадом по схеме: профиль, приёмы пищи с позициями,
 * советы, подписки, счётчики. Учёт расходов на ИИ (AiUsage) не удаляется, но
 * теряет ссылку на пользователя (onDelete: SetNull) — в нём не остаётся ничего
 * личного, только модель, токены и стоимость, а без него разъедется отчётность.
 */
export async function deleteAccount(userId: number): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}
