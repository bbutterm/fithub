import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../api/server.js";
import { prisma } from "../../db.js";
import { signPhotoToken } from "../../auth/photoToken.js";
import { login, makeMeal, makeProfile, signInitData } from "./helpers.js";

// Фото-прокси ходит в Telegram за файлом — единственный поход наружу в этих тестах
vi.mock("../../services/tgfiles.js", () => ({
  downloadTelegramFile: vi.fn(async (fileId: string) => {
    if (fileId === "file_broken") throw new Error("telegram unavailable");
    return { buffer: Buffer.from("fake-jpeg"), contentType: "image/jpeg" };
  }),
  telegramFileToDataUrl: vi.fn(async () => "data:image/jpeg;base64,AAAA")
}));

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("вход через Telegram", () => {
  it("подписанная initData даёт токен и заводит пользователя", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: signInitData({ id: 500100, first_name: "Аня" }) }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.hasProfile).toBe(false);
    expect(await prisma.user.count({ where: { tgUserId: BigInt(500100) } })).toBe(1);
  });

  it("подделанная подпись отклоняется", async () => {
    // Портим подпись гарантированно: замена первого символа на «0» в одном
    // случае из шестнадцати попадала в тот же символ, и тест мигал.
    const signed = signInitData({ id: 500100 });
    const hash = /hash=([0-9a-f]+)/.exec(signed)![1]!;
    const broken = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    const tampered = signed.replace(`hash=${hash}`, `hash=${broken}`);
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData: tampered } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_init_data");
  });

  it("initData старше суток не принимается", async () => {
    const old = Math.floor(Date.now() / 1000) - 25 * 3600;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: signInitData({ id: 500100 }, old) }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("доступ к своим данным", () => {
  it("с токеном отдаётся собственный профиль", async () => {
    const me = await login(app, 500101);
    await makeProfile(me.userId);
    const res = await app.inject({ method: "GET", url: "/api/me", headers: me.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(me.userId);
  });

  it("без токена закрытый маршрут отвечает 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("чужой приём пищи не виден по прямому id", async () => {
    const owner = await login(app, 500102);
    const stranger = await login(app, 500103);
    const meal = await makeMeal(owner.userId);
    expect((await app.inject({ method: "GET", url: `/api/meals/${meal.id}`, headers: owner.auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/meals/${meal.id}`, headers: stranger.auth })).statusCode).toBe(404);
  });
});

describe("профиль и нормы", () => {
  const valid = {
    gender: "male",
    birthYear: 1990,
    heightCm: 180,
    weightKg: 80,
    activityLevel: "moderate",
    goal: "maintain",
    dietType: "none",
    allergies: [],
    dislikes: [],
    medicalDiets: [],
    dietNotes: null,
    adviceTone: "friendly",
    adviceTime: "09:00",
    adviceEnabled: true
  };

  it("корректный профиль сохраняется и получает расчётные нормы", async () => {
    const me = await login(app, 500110);
    const res = await app.inject({ method: "PUT", url: "/api/profile", headers: me.auth, payload: valid });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.computedNorms.targetKcal).toBeGreaterThan(1500);
    expect(body.profile.targetProtein).toBeGreaterThan(0);
  });

  it("невозможный рост отклоняется с 400", async () => {
    const me = await login(app, 500111);
    const res = await app.inject({ method: "PUT", url: "/api/profile", headers: me.auth, payload: { ...valid, heightCm: 10 } });
    expect(res.statusCode).toBe(400);
  });

  it("несуществующий часовой пояс отклоняется", async () => {
    const me = await login(app, 500113);
    const res = await app.inject({ method: "PUT", url: "/api/profile", headers: me.auth, payload: { ...valid, tz: "Europe/Атлантида" } });
    expect(res.statusCode).toBe(400);
  });

  it("настоящий часовой пояс сохраняется", async () => {
    const me = await login(app, 500114);
    const res = await app.inject({ method: "PUT", url: "/api/profile", headers: me.auth, payload: { ...valid, tz: "Asia/Vladivostok" } });
    expect(res.statusCode).toBe(200);
    const day = await app.inject({ method: "GET", url: "/api/day", headers: me.auth });
    expect(day.statusCode).toBe(200);
  });

  it("неизвестный режим питания отбрасывается, известный сохраняется", async () => {
    const me = await login(app, 500112);
    const res = await app.inject({
      method: "PUT",
      url: "/api/profile",
      headers: me.auth,
      payload: { ...valid, medicalDiets: ["table5", "диета-из-интернета"] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.medicalDiets).toEqual(["table5"]);
  });
});

describe("дневник", () => {
  it("за сегодня отдаются свои приёмы с итогами", async () => {
    const me = await login(app, 500120);
    await makeMeal(me.userId, { kcal: 400 });
    await makeMeal(me.userId, { kcal: 600 });
    const res = await app.inject({ method: "GET", url: "/api/day", headers: me.auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meals).toHaveLength(2);
    expect(body.totals.totalKcal).toBe(1000);
  });

  it("правка граммов в чужом приёме отвечает 404", async () => {
    const owner = await login(app, 500121);
    const stranger = await login(app, 500122);
    const meal = await makeMeal(owner.userId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/meals/${meal.id}/items/${meal.items[0]!.id}`,
      headers: stranger.auth,
      payload: { grams: 100 }
    });
    expect(res.statusCode).toBe(404);
    expect(await prisma.mealItem.findUniqueOrThrow({ where: { id: meal.items[0]!.id } })).toMatchObject({ grams: 300 });
  });

  it("правка граммов пересчитывает КБЖУ пропорционально", async () => {
    const me = await login(app, 500123);
    const meal = await makeMeal(me.userId, { kcal: 600, protein: 30 });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/meals/${meal.id}/items/${meal.items[0]!.id}`,
      headers: me.auth,
      payload: { grams: 150 } // было 300
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meal.totalKcal).toBe(300);
    expect(res.json().meal.totalProtein).toBe(15);
  });

  it("время приёма в будущем не принимается", async () => {
    const me = await login(app, 500124);
    const meal = await makeMeal(me.userId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/meals/${meal.id}`,
      headers: me.auth,
      payload: { eatenAt: new Date(Date.now() + 3 * 3600_000).toISOString() }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_time");
  });
});

describe("фото-прокси", () => {
  it("с действующей подписью картинка отдаётся", async () => {
    const me = await login(app, 500130);
    const meal = await makeMeal(me.userId);
    const token = signPhotoToken(meal.id, me.userId);
    const res = await app.inject({ method: "GET", url: `/api/photos/${meal.id}?t=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });

  it("без подписи доступа нет", async () => {
    const me = await login(app, 500131);
    const meal = await makeMeal(me.userId);
    expect((await app.inject({ method: "GET", url: `/api/photos/${meal.id}` })).statusCode).toBe(401);
  });

  it("подпись от другого приёма не подходит", async () => {
    const me = await login(app, 500132);
    const mine = await makeMeal(me.userId);
    const other = await makeMeal(me.userId);
    const token = signPhotoToken(other.id, me.userId);
    const res = await app.inject({ method: "GET", url: `/api/photos/${mine.id}?t=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(401);
  });

  it("недоступный файл в Telegram отвечает 502, а не падением", async () => {
    const me = await login(app, 500133);
    const meal = await makeMeal(me.userId, { photoFileId: "file_broken" });
    const token = signPhotoToken(meal.id, me.userId);
    const res = await app.inject({ method: "GET", url: `/api/photos/${meal.id}?t=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(502);
  });
});
