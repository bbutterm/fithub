import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";

/** Проверка живости: отвечает только если и приложение, и база на связи. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });
  app.get("/api/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });
}
