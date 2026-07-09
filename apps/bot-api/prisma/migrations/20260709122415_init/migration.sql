-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "ActivityLevel" AS ENUM ('sedentary', 'light', 'moderate', 'high');

-- CreateEnum
CREATE TYPE "Goal" AS ENUM ('lose', 'maintain', 'gain');

-- CreateEnum
CREATE TYPE "DietType" AS ENUM ('none', 'vegetarian', 'vegan', 'keto', 'halal');

-- CreateEnum
CREATE TYPE "AdviceTone" AS ENUM ('strict', 'friendly', 'scientific');

-- CreateEnum
CREATE TYPE "MealSource" AS ENUM ('photo', 'text', 'manual');

-- CreateEnum
CREATE TYPE "AdviceKind" AS ENUM ('daily', 'monthly');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'pro');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'expired', 'canceled');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "tgUserId" BIGINT NOT NULL,
    "firstName" TEXT,
    "username" TEXT,
    "tz" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "userId" INTEGER NOT NULL,
    "gender" "Gender" NOT NULL DEFAULT 'male',
    "birthYear" INTEGER,
    "heightCm" INTEGER,
    "weightKg" DOUBLE PRECISION,
    "activityLevel" "ActivityLevel" NOT NULL DEFAULT 'moderate',
    "goal" "Goal" NOT NULL DEFAULT 'maintain',
    "dietType" "DietType" NOT NULL DEFAULT 'none',
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dislikes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetKcal" INTEGER,
    "targetProtein" INTEGER,
    "targetFat" INTEGER,
    "targetCarbs" INTEGER,
    "adviceTone" "AdviceTone" NOT NULL DEFAULT 'friendly',
    "adviceTime" TEXT NOT NULL DEFAULT '09:00',
    "adviceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Meal" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "photoFileId" TEXT,
    "photoS3Key" TEXT,
    "eatenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalKcal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalProtein" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalFat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCarbs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aiComment" TEXT,
    "overallConfidence" DOUBLE PRECISION,
    "source" "MealSource" NOT NULL,

    CONSTRAINT "Meal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealItem" (
    "id" SERIAL NOT NULL,
    "mealId" INTEGER NOT NULL,
    "dish" TEXT NOT NULL,
    "grams" DOUBLE PRECISION NOT NULL,
    "kcal" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION NOT NULL,
    "fat" DOUBLE PRECISION NOT NULL,
    "carbs" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "MealItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyAdvice" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "kind" "AdviceKind" NOT NULL DEFAULT 'daily',
    "adviceText" TEXT NOT NULL,
    "statsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyAdvice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "plan" "Plan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "starsPaymentId" TEXT,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "userId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "photoCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("userId","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_tgUserId_key" ON "User"("tgUserId");

-- CreateIndex
CREATE INDEX "Meal_userId_eatenAt_idx" ON "Meal"("userId", "eatenAt");

-- CreateIndex
CREATE INDEX "DailyAdvice_userId_kind_idx" ON "DailyAdvice"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DailyAdvice_userId_date_kind_key" ON "DailyAdvice"("userId", "date", "kind");

-- CreateIndex
CREATE INDEX "Subscription_userId_status_idx" ON "Subscription"("userId", "status");

-- CreateIndex
CREATE INDEX "Subscription_status_expiresAt_idx" ON "Subscription"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meal" ADD CONSTRAINT "Meal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealItem" ADD CONSTRAINT "MealItem_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "Meal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyAdvice" ADD CONSTRAINT "DailyAdvice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
