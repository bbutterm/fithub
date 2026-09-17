-- Режим питания: лечебные диеты в профиле и отметка соответствия в приёме пищи.
--
-- medicalDiets — массив идентификаторов из src/diets.ts, а не enum: режимы
-- сочетаются (стол №5 + средиземноморская — обычное назначение), и добавление
-- нового режима не должно требовать миграции типа.
-- IF NOT EXISTS: миграция может быть накачена вне Prisma (через панель или
-- MCP), и тогда последующий `prisma migrate deploy` повторит её. Повтор должен
-- быть безобидным, а не падать на «колонка уже существует».
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "medicalDiets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "dietNotes" TEXT;

-- Отметка хранится вместе с приёмом пищи, иначе она пропадала бы при каждой
-- перерисовке карточки — например, после уточнения блюда ответом на сообщение.
ALTER TABLE "Meal" ADD COLUMN IF NOT EXISTS "dietNote" TEXT;
ALTER TABLE "Meal" ADD COLUMN IF NOT EXISTS "dietVerdict" TEXT;
