-- Режим питания: лечебные диеты в профиле и отметка соответствия в приёме пищи.
--
-- medicalDiets — массив идентификаторов из src/diets.ts, а не enum: режимы
-- сочетаются (стол №5 + средиземноморская — обычное назначение), и добавление
-- нового режима не должно требовать миграции типа.
ALTER TABLE "Profile" ADD COLUMN "medicalDiets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Profile" ADD COLUMN "dietNotes" TEXT;

-- Отметка хранится вместе с приёмом пищи, иначе она пропадала бы при каждой
-- перерисовке карточки — например, после уточнения блюда ответом на сообщение.
ALTER TABLE "Meal" ADD COLUMN "dietNote" TEXT;
ALTER TABLE "Meal" ADD COLUMN "dietVerdict" TEXT;
