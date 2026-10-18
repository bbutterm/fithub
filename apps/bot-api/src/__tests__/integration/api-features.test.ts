import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../api/server.js";
import { prisma } from "../../db.js";
import { bot } from "../../bot/bot.js";
import { captureBotApi, login, makeMeal, makeProfile } from "./helpers.js";

vi.mock("../../services/tgfiles.js", () => ({
  downloadTelegramFile: vi.fn(async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" })),
  telegramFileToDataUrl: vi.fn(async () => "data:image/jpeg;base64,AAAA")
}));

const ADMIN_TG = 777001; // совпадает с ADMIN_TG_IDS в конфиге тестов

let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  captureBotApi(bot);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("мои блюда", () => {
  it("приём сохраняется как блюдо и записывается обратно в дневник", async () => {
    const me = await login(app, 500200);
    const meal = await makeMeal(me.userId, { dish: "борщ", kcal: 400 });

    const saved = await app.inject({ method: "POST", url: "/api/recipes", headers: me.auth, payload: { mealId: meal.id } });
    expect(saved.statusCode).toBe(200);
    const recipeId = saved.json().recipe.id;

    const logged = await app.inject({ method: "POST", url: `/api/recipes/${recipeId}/log`, headers: me.auth, payload: { multiplier: 0.5 } });
    expect(logged.statusCode).toBe(200);
    expect(logged.json().meal.totalKcal).toBe(200);
  });

  it("чужое блюдо не записать и не переименовать", async () => {
    const owner = await login(app, 500201);
    const stranger = await login(app, 500202);
    const meal = await makeMeal(owner.userId);
    const recipeId = (await app.inject({ method: "POST", url: "/api/recipes", headers: owner.auth, payload: { mealId: meal.id } })).json().recipe.id;

    expect((await app.inject({ method: "POST", url: `/api/recipes/${recipeId}/log`, headers: stranger.auth, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/recipes/${recipeId}`, headers: stranger.auth, payload: { name: "моё" } })).statusCode).toBe(404);
  });

  it("запись блюда не тратит дневной лимит распознаваний", async () => {
    const me = await login(app, 500203);
    const meal = await makeMeal(me.userId);
    const recipeId = (await app.inject({ method: "POST", url: "/api/recipes", headers: me.auth, payload: { mealId: meal.id } })).json().recipe.id;
    await app.inject({ method: "POST", url: `/api/recipes/${recipeId}/log`, headers: me.auth, payload: {} });
    expect(await prisma.usageCounter.count({ where: { userId: me.userId } })).toBe(0);
  });
});

describe("челленджи", () => {
  it("челлендж из шаблона создаётся и виден в состоянии экрана", async () => {
    const me = await login(app, 500210);
    await makeProfile(me.userId);
    const created = await app.inject({ method: "POST", url: "/api/challenges", headers: me.auth, payload: { template: "protein7" } });
    expect(created.statusCode).toBe(200);
    expect(created.json().joinCode).toMatch(/^[A-Z0-9]{6}$/);

    const state = await app.inject({ method: "GET", url: "/api/challenges", headers: me.auth });
    expect(state.json().active?.title).toBe("Белок 7 дней");
    expect(state.json().active?.inviteUrl).toContain("Fithub_ai_bot");
  });

  it("неизвестный шаблон отвергается", async () => {
    const me = await login(app, 500211);
    const res = await app.inject({ method: "POST", url: "/api/challenges", headers: me.auth, payload: { template: "марафон-из-головы" } });
    expect(res.statusCode).toBe(404);
  });

  it("второй активный челлендж не создаётся", async () => {
    const me = await login(app, 500212);
    await makeProfile(me.userId);
    await app.inject({ method: "POST", url: "/api/challenges", headers: me.auth, payload: { template: "protein7" } });
    const second = await app.inject({ method: "POST", url: "/api/challenges", headers: me.auth, payload: { template: "deficit14" } });
    expect(second.statusCode).toBe(409);
  });

  it("планка из шаблона признаётся выполнимой", async () => {
    const me = await login(app, 500213);
    await makeProfile(me.userId, { weightKg: 60 });
    const res = await app.inject({ method: "GET", url: "/api/challenges/feasibility?template=protein7", headers: me.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).not.toBe("refuse");
  });

  it("своя завышенная планка признаётся невыполнимой", async () => {
    const me = await login(app, 500214);
    await makeProfile(me.userId, { weightKg: 60 });
    const res = await app.inject({ method: "GET", url: "/api/challenges/feasibility?template=protein7&value=400", headers: me.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe("refuse");
  });

  it("невыполнимый челлендж не создаётся даже прямым запросом к API", async () => {
    const me = await login(app, 500215);
    await makeProfile(me.userId, { weightKg: 60 });
    const res = await app.inject({ method: "POST", url: "/api/challenges", headers: me.auth, payload: { template: "protein7", value: 400 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("not_feasible");
    expect(await prisma.challenge.count({ where: { ownerId: me.userId } })).toBe(0);
  });
});

describe("админка", () => {
  it("админ видит сводку расходов", async () => {
    const admin = await login(app, ADMIN_TG, "Админ");
    const res = await app.inject({ method: "GET", url: "/api/admin/overview", headers: admin.auth });
    expect(res.statusCode).toBe(200);
  });

  it("обычный пользователь получает 403", async () => {
    const me = await login(app, 500220);
    expect((await app.inject({ method: "GET", url: "/api/admin/overview", headers: me.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", headers: me.auth })).statusCode).toBe(403);
  });

  it("выдача Pro меняет план пользователя", async () => {
    const admin = await login(app, ADMIN_TG, "Админ");
    const user = await login(app, 500221);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: user.auth })).json().plan).toBe("free");

    const granted = await app.inject({ method: "POST", url: `/api/admin/users/${user.userId}/pro`, headers: admin.auth, payload: { days: 30 } });
    expect(granted.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: user.auth })).json().plan).toBe("pro");
  });
});

describe("аналитика", () => {
  it("неделя доступна всем", async () => {
    const me = await login(app, 500230);
    await makeProfile(me.userId);
    await makeMeal(me.userId);
    const res = await app.inject({ method: "GET", url: "/api/analytics?period=week", headers: me.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toHaveLength(7);
  });

  it("месяц закрыт для бесплатного тарифа", async () => {
    const me = await login(app, 500231);
    await makeProfile(me.userId);
    const res = await app.inject({ method: "GET", url: "/api/analytics?period=month", headers: me.auth });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("pro_required");
  });
});

describe("крон", () => {
  it("без секрета маршрут закрыт", async () => {
    expect((await app.inject({ method: "GET", url: "/api/cron/daily" })).statusCode).toBe(401);
  });

  it("с секретом задание выполняется", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cron/daily", headers: { authorization: "Bearer test-cron-secret" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("чужой секрет не подходит", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cron/daily", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("удаление аккаунта", () => {
  it("удаляет пользователя вместе с записями", async () => {
    const me = await login(app, 500240);
    await makeProfile(me.userId);
    await makeMeal(me.userId);

    const res = await app.inject({ method: "DELETE", url: "/api/me", headers: me.auth });
    expect(res.statusCode).toBe(200);
    expect(await prisma.user.count({ where: { id: me.userId } })).toBe(0);
    expect(await prisma.meal.count({ where: { userId: me.userId } })).toBe(0);
  });

  it("после удаления токен больше не работает", async () => {
    const me = await login(app, 500241);
    await app.inject({ method: "DELETE", url: "/api/me", headers: me.auth });
    const res = await app.inject({ method: "GET", url: "/api/day", headers: me.auth });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
