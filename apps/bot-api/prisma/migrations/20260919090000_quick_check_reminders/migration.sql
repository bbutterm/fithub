-- Режим «можно?» и вечернее напоминание.
--
-- IF NOT EXISTS везде: миграция может быть накачена вне Prisma (панель, MCP),
-- и повтор через `prisma migrate deploy` должен быть безобидным.

-- Вечернее напоминание «сегодня в дневнике пусто»: выключатель в профиле и дата
-- последней отправки на пользователе (у части людей профиля нет — они не прошли
-- онбординг, а напоминание нужно именно им).
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "reminderEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastReminderDate" TEXT;

-- Разовая проверка еды без записи в дневник. Распознавание сохраняется, чтобы
-- кнопка «Записать» не требовала второго платного вызова модели.
CREATE TABLE IF NOT EXISTS "QuickCheck" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "recognition" JSONB NOT NULL,
    "source" "MealSource" NOT NULL,
    "photoFileId" TEXT,
    "photoThumbFileId" TEXT,
    "dietNote" TEXT,
    "dietVerdict" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "QuickCheck_userId_createdAt_idx" ON "QuickCheck"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "QuickCheck_createdAt_idx" ON "QuickCheck"("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'QuickCheck_userId_fkey'
  ) THEN
    ALTER TABLE "QuickCheck" ADD CONSTRAINT "QuickCheck_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Как и на остальных таблицах проекта: RLS включён, политик нет, владелец обходит.
ALTER TABLE "QuickCheck" ENABLE ROW LEVEL SECURITY;
