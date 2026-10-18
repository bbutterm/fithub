import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

/** Сессия Mini App: только заголовок Bearer, токен в адресе больше не принимаем. */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "unauthorized" });
  }
}

/** Задания по расписанию: общий секрет в заголовке, если он задан. */
export async function cronAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.CRON_SECRET) return;
  if (request.headers.authorization !== `Bearer ${config.CRON_SECRET}`) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}
