import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { checkBurstLimit, checkRecognitionLimit, refundRecognition, tryConsumeRecognition } from "../../services/limits.js";
import { acquireRecognitionLock, releaseRecognitionLock } from "../../services/locks.js";
import { expireSubscriptions, extendPro, getPlan } from "../../services/subscription.js";

let user: User;
beforeEach(async () => {
  user = await prisma.user.create({ data: { tgUserId: BigInt(630001), firstName: "Лимит" } });
});

describe("дневной лимит распознаваний", () => {
  it("попытки расходуются до предела, дальше отказ", async () => {
    for (let i = 0; i < config.FREE_PHOTOS_PER_DAY; i++) {
      expect((await tryConsumeRecognition(user)).allowed).toBe(true);
    }
    const over = await tryConsumeRecognition(user);
    expect(over.allowed).toBe(false);
    expect(over.limit).toBe(config.FREE_PHOTOS_PER_DAY);
  });

  it("возврат попытки после сбоя снова открывает распознавание", async () => {
    for (let i = 0; i < config.FREE_PHOTOS_PER_DAY; i++) await tryConsumeRecognition(user);
    expect((await tryConsumeRecognition(user)).allowed).toBe(false);

    await refundRecognition(user);
    expect((await tryConsumeRecognition(user)).allowed).toBe(true);
  });

  it("персональный лимит админа важнее общего", async () => {
    const generous = await prisma.user.update({ where: { id: user.id }, data: { dailyLimitOverride: config.FREE_PHOTOS_PER_DAY + 2 } });
    for (let i = 0; i < config.FREE_PHOTOS_PER_DAY + 2; i++) {
      expect((await tryConsumeRecognition(generous)).allowed).toBe(true);
    }
    expect((await tryConsumeRecognition(generous)).allowed).toBe(false);
  });

  it("нулевой персональный лимит закрывает распознавание сразу", async () => {
    const blocked = await prisma.user.update({ where: { id: user.id }, data: { dailyLimitOverride: 0 } });
    expect((await tryConsumeRecognition(blocked)).allowed).toBe(false);
    expect(await prisma.usageCounter.count({ where: { userId: user.id } })).toBe(0);
  });

  it("проверка лимита ничего не расходует", async () => {
    await checkRecognitionLimit(user);
    await checkRecognitionLimit(user);
    expect((await tryConsumeRecognition(user)).allowed).toBe(true);
    const counter = await prisma.usageCounter.findFirstOrThrow({ where: { userId: user.id } });
    expect(counter.photoCount).toBe(1);
  });
});

describe("защита от шквала запросов", () => {
  it("до дюжины вызовов в минуту — можно", async () => {
    expect(await checkBurstLimit(user.id)).toBe(true);
  });

  it("после дюжины вызовов за минуту — нельзя", async () => {
    await prisma.aiUsage.createMany({
      data: Array.from({ length: 12 }, () => ({ userId: user.id, client: "vision", model: "stub", purpose: "photo" }))
    });
    expect(await checkBurstLimit(user.id)).toBe(false);
  });

  it("старые вызовы в счёт не идут", async () => {
    await prisma.aiUsage.createMany({
      data: Array.from({ length: 12 }, () => ({ userId: user.id, client: "vision", model: "stub", purpose: "photo" }))
    });
    await prisma.aiUsage.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await checkBurstLimit(user.id)).toBe(true);
  });
});

describe("блокировка параллельного распознавания", () => {
  it("второй запрос того же человека не проходит, пока идёт первый", async () => {
    expect(await acquireRecognitionLock(user.id)).toBe(true);
    expect(await acquireRecognitionLock(user.id)).toBe(false);
    await releaseRecognitionLock(user.id);
    expect(await acquireRecognitionLock(user.id)).toBe(true);
  });

  it("блокировка персональная: другой человек не ждёт", async () => {
    const other = await prisma.user.create({ data: { tgUserId: BigInt(630002) } });
    expect(await acquireRecognitionLock(user.id)).toBe(true);
    expect(await acquireRecognitionLock(other.id)).toBe(true);
  });
});

describe("подписка", () => {
  it("без подписки план бесплатный, после выдачи — Pro", async () => {
    expect(await getPlan(user.id)).toBe("free");
    await extendPro(user.id, 30);
    expect(await getPlan(user.id)).toBe("pro");
  });

  it("истёкшая подписка возвращает на бесплатный тариф", async () => {
    await extendPro(user.id, 30);
    await prisma.subscription.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
    expect(await getPlan(user.id)).toBe("free");
  });

  it("ежедневная уборка помечает истёкшие подписки", async () => {
    await extendPro(user.id, 30);
    await prisma.subscription.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });

    await expireSubscriptions();
    expect(await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ status: "expired" });
  });

  it("продление складывает дни, а не начинает срок заново", async () => {
    await extendPro(user.id, 30);
    const first = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    await extendPro(user.id, 30);
    const second = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id }, orderBy: { expiresAt: "desc" } });
    expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
  });
});
