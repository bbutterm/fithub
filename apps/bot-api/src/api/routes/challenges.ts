import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { bot } from "../../bot/bot.js";
import { assessFeasibility, CHALLENGE_TEMPLATES, type ChallengeRule, describeRule, getTemplate, withValue } from "../../challenges.js";
import {
  activeChallengeOf,
  createChallenge,
  dayNumber,
  dayResultsOf,
  finishedChallengesOf,
  historyFacts,
  participantsOf,
  progressOf,
  quitChallenge,
  ruleOf
} from "../../services/challenges.js";
import { localDateStr } from "../../utils/tz.js";
import { authenticate } from "../guards.js";

let botUsernameCache: string | null = null;
async function inviteBase(): Promise<string> {
  if (!botUsernameCache) {
    try {
      botUsernameCache = (await bot.api.getMe()).username;
    } catch {
      return ""; // Telegram недоступен — отдадим только код, ссылку соберёт клиент
    }
  }
  return `https://t.me/${botUsernameCache}?start=ch_`;
}

/** Челленджи: состояние экрана, проверка выполнимости, старт и выход. */
export async function challengeRoutes(app: FastifyInstance): Promise<void> {
  // --- Челленджи ---

  /** Состояние экрана целиком: активный челлендж, шаблоны и история. */
  app.get("/api/challenges", { preHandler: authenticate }, async (request) => {
    const uid = request.user.uid;
    // Три независимых запроса — параллельно: между Vercel и базой сотня
    // миллисекунд на каждый, последовательно это заметно на глаз
    const [user, part, finishedRows] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: uid } }),
      activeChallengeOf(uid),
      finishedChallengesOf(uid)
    ]);

    const active = part
      ? await (async () => {
          const ch = part.challenge;
          const [progress, days, participants] = await Promise.all([
            progressOf(ch.id, uid, ch.days),
            dayResultsOf(ch.id, uid),
            participantsOf(ch.id, uid)
          ]);
          return {
            id: ch.id,
            title: ch.title,
            ruleText: describeRule(ruleOf(ch)),
            startDate: ch.startDate,
            totalDays: ch.days,
            dayNo: dayNumber(ch, localDateStr(user.tz)),
            joinCode: ch.joinCode,
            inviteUrl: `${await inviteBase()}${ch.joinCode}`,
            jokersLeft: part.jokersLeft,
            progress,
            days,
            participants
          };
        })()
      : null;

    const finished = finishedRows.map((p) => ({
      id: p.challenge.id,
      title: p.challenge.title,
      totalDays: p.challenge.days,
      status: p.status
    }));

    return {
      active,
      finished,
      templates: CHALLENGE_TEMPLATES.map((t) => ({
        id: t.id,
        title: t.title,
        hint: t.hint,
        days: t.days,
        ruleText: describeRule(t.rule)
      }))
    };
  });

  /** Выполнимость шаблона по собственной истории — до старта, а не после провала. */
  app.get("/api/challenges/feasibility", { preHandler: authenticate }, async (request, reply) => {
    const q = request.query as { template?: string; value?: string };
    const template = getTemplate(q.template ?? "");
    if (!template) return reply.code(404).send({ error: "not_found" });
    // Значение учитываем так же, как при создании: иначе проверка отвечает про
    // планку из шаблона, а человек берёт свою, и «выполнимо» относится не к ней.
    const value = Number(q.value);
    const rule = Number.isInteger(value) && value > 0 ? withValue(template.rule, value) : template.rule;
    return assessChallenge(request.user.uid, rule, template.days);
  });

  /** Выполнимость правила по записям самого человека — одна реализация на проверку и на создание. */
  async function assessChallenge(uid: number, rule: ChallengeRule, days: number) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    const [profile, history] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: uid } }),
      historyFacts(uid, user.tz)
    ]);
    return assessFeasibility({
      rule,
      days,
      history,
      profile: profile ? { weightKg: profile.weightKg, gender: profile.gender, targetKcal: profile.targetKcal } : null
    });
  }

  app.post("/api/challenges", { preHandler: authenticate }, async (request, reply) => {
    const body = z
      .object({ template: z.string().min(1), value: z.number().int().positive().optional() })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const template = getTemplate(body.data.template);
    if (!template) return reply.code(404).send({ error: "not_found" });
    const uid = request.user.uid;
    // Один активный челлендж: три сразу — это ноль выполненных
    if (await activeChallengeOf(uid)) return reply.code(409).send({ error: "already_active" });

    const rule = body.data.value ? withValue(template.rule, body.data.value) : template.rule;
    // Заведомо невыполнимую планку не заводим. В интерфейсе её и не предложат,
    // но маршрут принимает любое число, а челлендж, проваленный на второй день,
    // отбивает желание начинать следующий.
    if (body.data.value) {
      const check = await assessChallenge(uid, rule, template.days);
      if (check.verdict === "refuse") return reply.code(422).send({ error: "not_feasible", reason: check.reason });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    const challenge = await createChallenge({
      ownerId: uid,
      title: template.title,
      rule,
      days: template.days,
      tz: user.tz
    });
    return { id: challenge.id, joinCode: challenge.joinCode, startDate: challenge.startDate };
  });

  app.delete("/api/challenges/:id", { preHandler: authenticate }, async (request) => {
    await quitChallenge(Number((request.params as { id: string }).id), request.user.uid);
    return { ok: true };
  });

  // Справочник режимов питания. Отдаётся с сервера, а не дублируется в Mini App:
  // правила и список живут в одном месте — src/diets.ts.
}
