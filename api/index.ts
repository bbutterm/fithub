// Vercel Serverless Function: все запросы /api/* переписываются сюда (см. vercel.json)
// и обрабатываются Fastify-приложением из apps/bot-api.
// Динамический import обязателен: Vercel может собрать этот файл как CommonJS,
// а код apps/bot-api — ES-модули (require() ESM невозможен, ERR_REQUIRE_ESM).
import type { IncomingMessage, ServerResponse } from "node:http";

type FastifyApp = {
  ready: () => Promise<unknown>;
  server: { emit: (event: string, req: IncomingMessage, res: ServerResponse) => void };
};

let ready: Promise<FastifyApp> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= (async () => {
    const { buildServer } = await import("../apps/bot-api/src/api/server.js");
    const app = await buildServer();
    await app.ready();
    return app as unknown as FastifyApp;
  })();
  const app = await ready;
  app.server.emit("request", req, res);
}
