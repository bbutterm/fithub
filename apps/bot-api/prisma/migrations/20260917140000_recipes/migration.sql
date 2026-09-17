-- Сохранённые блюда: состав и КБЖУ на порцию.
--
-- IF NOT EXISTS везде: миграции на этом проекте накатываются вручную и иногда
-- мимо Prisma, поэтому повторный запуск должен быть безобидным.
CREATE TABLE IF NOT EXISTS "Recipe" (
  "id"           SERIAL PRIMARY KEY,
  "userId"       INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name"         TEXT NOT NULL,
  "portionGrams" DOUBLE PRECISION NOT NULL,
  "kcal"         DOUBLE PRECISION NOT NULL,
  "protein"      DOUBLE PRECISION NOT NULL,
  "fat"          DOUBLE PRECISION NOT NULL,
  "carbs"        DOUBLE PRECISION NOT NULL,
  "items"        JSONB NOT NULL,
  "sourceMealId" INTEGER,
  "timesUsed"    INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt"   TIMESTAMPTZ,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Одно имя на пользователя: повторное сохранение того же блюда обновляет запись,
-- а не плодит «Овсянка», «Овсянка (2)», «Овсянка (3)».
CREATE UNIQUE INDEX IF NOT EXISTS "Recipe_userId_name_key" ON "Recipe"("userId", "name");
CREATE INDEX IF NOT EXISTS "Recipe_userId_timesUsed_idx" ON "Recipe"("userId", "timesUsed");

-- Таблица создана после миграции enable_rls, поэтому RLS включаем явно
ALTER TABLE "Recipe" ENABLE ROW LEVEL SECURITY;
