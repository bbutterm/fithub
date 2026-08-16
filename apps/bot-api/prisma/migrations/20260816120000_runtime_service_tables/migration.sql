-- Служебные таблицы рантайма: раньше создавались лениво из кода
-- (CREATE TABLE IF NOT EXISTS в services/locks.ts и api/server.ts), теперь — модели Prisma.
-- IF NOT EXISTS: в базах, где ленивый DDL уже отработал, таблицы совпадают один в один
-- (INTEGER/BIGINT PRIMARY KEY + TIMESTAMPTZ NOT NULL DEFAULT now()), и миграция проходит как no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "RecognitionLock" (
    "userId" INTEGER NOT NULL,
    "lockedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecognitionLock_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProcessedUpdate" (
    "updateId" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedUpdate_pkey" PRIMARY KEY ("updateId")
);
