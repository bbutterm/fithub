/** Полезная нагрузка сессионного токена Mini App: один пользователь, ничего больше. */

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { uid: number };
    user: { uid: number };
  }
}

export {};
