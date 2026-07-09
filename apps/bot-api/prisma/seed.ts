/* Seed: тестовый пользователь + неделя фейковых приёмов пищи.
   Запуск: pnpm --filter bot-api seed
   Свой Telegram ID можно передать: SEED_TG_USER_ID=12345 pnpm --filter bot-api seed */
import { PrismaClient, type MealSource } from "@prisma/client";

const prisma = new PrismaClient();

const TG_USER_ID = BigInt(process.env.SEED_TG_USER_ID ?? "123456789");
const TZ = process.env.TZ_DEFAULT ?? "Europe/Moscow";

interface SeedDish {
  dish: string;
  grams: number;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
}

const BREAKFASTS: SeedDish[][] = [
  [
    { dish: "Овсяная каша на молоке", grams: 250, kcal: 260, protein: 9, fat: 7, carbs: 40 },
    { dish: "Банан", grams: 120, kcal: 107, protein: 1.3, fat: 0.4, carbs: 27 }
  ],
  [
    { dish: "Яичница из двух яиц", grams: 120, kcal: 210, protein: 14, fat: 16, carbs: 1 },
    { dish: "Тост с сыром", grams: 60, kcal: 180, protein: 8, fat: 8, carbs: 18 }
  ],
  [{ dish: "Творог 5% с мёдом", grams: 200, kcal: 240, protein: 32, fat: 10, carbs: 14 }]
];

const LUNCHES: SeedDish[][] = [
  [
    { dish: "Борщ со сметаной", grams: 300, kcal: 180, protein: 8, fat: 8, carbs: 18 },
    { dish: "Хлеб ржаной", grams: 60, kcal: 130, protein: 4, fat: 1, carbs: 26 }
  ],
  [
    { dish: "Гречка с курицей", grams: 350, kcal: 420, protein: 38, fat: 10, carbs: 45 },
    { dish: "Овощной салат", grams: 150, kcal: 80, protein: 2, fat: 5, carbs: 8 }
  ],
  [
    { dish: "Паста болоньезе", grams: 320, kcal: 520, protein: 24, fat: 18, carbs: 62 }
  ]
];

const DINNERS: SeedDish[][] = [
  [
    { dish: "Запечённая сёмга", grams: 180, kcal: 340, protein: 36, fat: 22, carbs: 0 },
    { dish: "Рис", grams: 150, kcal: 195, protein: 4, fat: 0.5, carbs: 42 }
  ],
  [
    { dish: "Куриная грудка гриль", grams: 200, kcal: 330, protein: 62, fat: 7, carbs: 0 },
    { dish: "Овощи на пару", grams: 200, kcal: 70, protein: 3, fat: 0.5, carbs: 13 }
  ],
  [{ dish: "Пицца Маргарита", grams: 250, kcal: 590, protein: 24, fat: 22, carbs: 74 }]
];

function utcForLocal(dayOffset: number, hour: number): Date {
  // Приближение для сида: Москва UTC+3 круглый год
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour - 3, Math.floor(Math.random() * 50), 0, 0);
  return d;
}

async function createMeal(userId: number, eatenAt: Date, dishes: SeedDish[], source: MealSource = "photo") {
  const totals = dishes.reduce(
    (acc, d) => ({
      kcal: acc.kcal + d.kcal,
      protein: acc.protein + d.protein,
      fat: acc.fat + d.fat,
      carbs: acc.carbs + d.carbs
    }),
    { kcal: 0, protein: 0, fat: 0, carbs: 0 }
  );
  await prisma.meal.create({
    data: {
      userId,
      eatenAt,
      source,
      totalKcal: totals.kcal,
      totalProtein: totals.protein,
      totalFat: totals.fat,
      totalCarbs: totals.carbs,
      aiComment: "Тестовая запись из seed.",
      overallConfidence: 0.85,
      items: { create: dishes.map((d) => ({ ...d, confidence: 0.85 })) }
    }
  });
}

async function main() {
  const user = await prisma.user.upsert({
    where: { tgUserId: TG_USER_ID },
    create: { tgUserId: TG_USER_ID, firstName: "Тест", username: "test_user", tz: TZ },
    update: {}
  });

  await prisma.profile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      gender: "male",
      birthYear: 1992,
      heightCm: 180,
      weightKg: 82,
      activityLevel: "moderate",
      goal: "lose",
      dietType: "none",
      allergies: ["арахис"],
      dislikes: ["сельдерей"],
      targetKcal: 2000,
      targetProtein: 148,
      targetFat: 74,
      targetCarbs: 186,
      adviceTone: "friendly",
      adviceTime: "09:00",
      adviceEnabled: true
    },
    update: {}
  });

  await prisma.meal.deleteMany({ where: { userId: user.id } });
  await prisma.dailyAdvice.deleteMany({ where: { userId: user.id } });

  // Неделя питания: −7 … −1 день; один день пропускаем (паттерн «день без записей»),
  // в паре дней нет завтрака и есть поздний ужин.
  for (let offset = -7; offset <= -1; offset++) {
    const i = Math.abs(offset) % 3;
    if (offset === -4) continue; // пустой день
    if (offset !== -2) await createMeal(user.id, utcForLocal(offset, 9), BREAKFASTS[i]!);
    await createMeal(user.id, utcForLocal(offset, 13), LUNCHES[i]!, i === 1 ? "text" : "photo");
    await createMeal(user.id, utcForLocal(offset, offset === -3 ? 22 : 19), DINNERS[i]!);
  }

  console.log(`Seed готов: пользователь tgUserId=${TG_USER_ID}, неделя приёмов пищи создана.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
