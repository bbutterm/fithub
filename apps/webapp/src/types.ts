export interface MealItem {
  id: number;
  dish: string;
  grams: number;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  confidence: number;
}

export interface Meal {
  id: number;
  eatenAt: string;
  totalKcal: number;
  totalProtein: number;
  totalFat: number;
  totalCarbs: number;
  aiComment: string | null;
  overallConfidence: number | null;
  source: string;
  hasPhoto: boolean;
  items: MealItem[];
}

export interface DayResponse {
  date: string;
  totals: { totalKcal: number; totalProtein: number; totalFat: number; totalCarbs: number };
  meals: Meal[];
}

export interface Profile {
  gender: "male" | "female";
  birthYear: number | null;
  heightCm: number | null;
  weightKg: number | null;
  activityLevel: "sedentary" | "light" | "moderate" | "high";
  goal: "lose" | "maintain" | "gain";
  dietType: "none" | "vegetarian" | "vegan" | "keto" | "halal";
  allergies: string[];
  dislikes: string[];
  medicalDiets: string[];
  dietNotes: string | null;
  targetKcal: number | null;
  targetProtein: number | null;
  targetFat: number | null;
  targetCarbs: number | null;
  adviceTone: "strict" | "friendly" | "scientific";
  adviceTime: string;
  adviceEnabled: boolean;
}

export interface MeResponse {
  user: { id: number; firstName: string | null; tz: string };
  profile: Profile | null;
  plan: "free" | "pro";
  subscriptionExpiresAt: string | null;
  isAdmin: boolean;
}

// --- Админка ---
export interface AdminOverview {
  usdRubRate: number;
  usersCount: number;
  usersToday: number;
  activePro: number;
  mealsCount: number;
  mealsToday: number;
  spend: { totalUsd: number; last30dUsd: number; todayUsd: number; promptTokens: number; completionTokens: number };
  spendByDay: Array<{ date: string; costUsd: number }>;
  byModel: Array<{ client: string; model: string; calls: number; promptTokens: number; completionTokens: number; costUsd: number }>;
}

export interface AdminUsageRow {
  createdAt: string;
  client: string;
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface AdminUser {
  id: number;
  tgUserId: string;
  firstName: string | null;
  username: string | null;
  createdAt: string;
  plan: "free" | "pro";
  proExpiresAt: string | null;
  dailyLimitOverride: number | null;
  mealsCount: number;
  aiCalls: number;
  tokens: number;
  costUsd: number;
  isAdmin: boolean;
}

export interface AnalyticsResponse {
  period: "week" | "month";
  days: Array<{ date: string; kcal: number; protein: number; fat: number; carbs: number; mealsCount: number }>;
  averages: { kcal: number; protein: number; fat: number; carbs: number };
  targets: { kcal: number | null; protein: number | null; fat: number | null; carbs: number | null };
  streak: number;
  monthlyInsight: { date: string; text: string } | null;
}

export interface SubscriptionResponse {
  plan: "free" | "pro";
  expiresAt: string | null;
  prices: { month: number; year: number };
  freeLimit: number;
  usedToday: number;
}

/** Режим питания из справочника сервера (GET /api/diets). */
export interface DietPreset {
  id: string;
  label: string;
  hint: string;
}
