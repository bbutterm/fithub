-- Общая лента еды («еда-тиндер»): публикация приёма, голоса, жалобы.
--
-- IF NOT EXISTS везде: миграции проекта исторически накатывались и вне Prisma,
-- повтор должен быть безобидным.

-- Публикация. По умолчанию выключено у всех: фото из личного дневника не
-- становятся публичными сами по себе — только по кнопке или явному тумблеру.
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "feedOptIn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meal" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meal" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);
ALTER TABLE "Meal" ADD COLUMN IF NOT EXISTS "feedHiddenAt" TIMESTAMP(3);
-- Счётчики денормализованы: карточка ленты и лидерборд читаются на каждом свайпе,
-- а голосуют реже. Обновляются в той же транзакции, что и вставка голоса.
ALTER TABLE "Meal" ADD COLUMN IF NOT EXISTS "likeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Meal" ADD COLUMN IF NOT EXISTS "voteCount" INTEGER NOT NULL DEFAULT 0;

-- Выборка ленты: публичные, не скрытые, сначала с наименьшим числом оценок.
CREATE INDEX IF NOT EXISTS "Meal_isPublic_feedHiddenAt_voteCount_idx"
  ON "Meal"("isPublic", "feedHiddenAt", "voteCount");

CREATE TABLE IF NOT EXISTS "FeedVote" (
    "mealId" INTEGER NOT NULL,
    "voterId" INTEGER NOT NULL,
    "liked" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedVote_pkey" PRIMARY KEY ("mealId", "voterId")
);
CREATE INDEX IF NOT EXISTS "FeedVote_voterId_createdAt_idx" ON "FeedVote"("voterId", "createdAt");
-- Недельный лидерборд: лайки за период.
CREATE INDEX IF NOT EXISTS "FeedVote_createdAt_liked_idx" ON "FeedVote"("createdAt", "liked");

CREATE TABLE IF NOT EXISTS "FeedReport" (
    "mealId" INTEGER NOT NULL,
    "reporterId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedReport_pkey" PRIMARY KEY ("mealId", "reporterId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FeedVote_mealId_fkey') THEN
    ALTER TABLE "FeedVote" ADD CONSTRAINT "FeedVote_mealId_fkey"
      FOREIGN KEY ("mealId") REFERENCES "Meal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FeedVote_voterId_fkey') THEN
    ALTER TABLE "FeedVote" ADD CONSTRAINT "FeedVote_voterId_fkey"
      FOREIGN KEY ("voterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FeedReport_mealId_fkey') THEN
    ALTER TABLE "FeedReport" ADD CONSTRAINT "FeedReport_mealId_fkey"
      FOREIGN KEY ("mealId") REFERENCES "Meal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FeedReport_reporterId_fkey') THEN
    ALTER TABLE "FeedReport" ADD CONSTRAINT "FeedReport_reporterId_fkey"
      FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Как и на остальных таблицах проекта: RLS включён, политик нет, владелец обходит.
ALTER TABLE "FeedVote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeedReport" ENABLE ROW LEVEL SECURITY;
