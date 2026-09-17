-- Челленджи: правило, срок, участники и результат каждого дня.
--
-- Правило и здесь, и в коде — JSON: типов правил будет больше, и добавление
-- нового не должно требовать миграции.
CREATE TABLE IF NOT EXISTS "Challenge" (
  "id"        SERIAL PRIMARY KEY,
  "ownerId"   INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title"     TEXT NOT NULL,
  "rule"      JSONB NOT NULL,
  "startDate" TEXT NOT NULL,
  "days"      INTEGER NOT NULL,
  "joinCode"  TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "Challenge_joinCode_key" ON "Challenge"("joinCode");

CREATE TABLE IF NOT EXISTS "ChallengeParticipant" (
  "challengeId" INTEGER NOT NULL REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId"      INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "joinedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "jokersLeft"  INTEGER NOT NULL DEFAULT 1,
  "status"      TEXT NOT NULL DEFAULT 'active',
  CONSTRAINT "ChallengeParticipant_pkey" PRIMARY KEY ("challengeId", "userId")
);
CREATE INDEX IF NOT EXISTS "ChallengeParticipant_userId_status_idx" ON "ChallengeParticipant"("userId", "status");

CREATE TABLE IF NOT EXISTS "ChallengeDay" (
  "challengeId" INTEGER NOT NULL REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId"      INTEGER NOT NULL,
  "date"        TEXT NOT NULL,
  "status"      TEXT NOT NULL,
  "fact"        TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ChallengeDay_pkey" PRIMARY KEY ("challengeId", "userId", "date")
);

-- Таблицы созданы после миграции enable_rls — включаем явно
ALTER TABLE "Challenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChallengeParticipant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChallengeDay" ENABLE ROW LEVEL SECURITY;
