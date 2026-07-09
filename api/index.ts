// Vercel Serverless Function: все запросы /api/* переписываются сюда (см. vercel.json)
// и обрабатываются Fastify-приложением из apps/bot-api.
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "../apps/bot-api/src/api/server.js";

let ready: Promise<Awaited<ReturnType<typeof buildServer>>> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= (async () => {
    const app = await buildServer();
    await app.ready();
    return app;
  })();
  const app = await ready;
  app.server.emit("request", req, res);
}
