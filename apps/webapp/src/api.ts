import { getRawInitData } from "./telegram";
import type {
  AdminOverview,
  AdminUsageRow,
  AdminUser,
  AnalyticsResponse,
  ChallengesResponse,
  DayResponse,
  DietPreset,
  Feasibility,
  Meal,
  MeResponse,
  Profile,
  Recipe,
  SubscriptionResponse
} from "./types";

let token: string | null = null;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      // Content-Type только при наличии тела: Fastify отвечает 400 на
      // "application/json" с пустым body (ломались DELETE-запросы)
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {})
    }
  });
  if (res.status === 401 && token && path !== "/api/auth/telegram") {
    // токен истёк — переавторизуемся по initData и повторим один раз
    token = null;
    await authorize();
    return request<T>(path, options);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  }
  return (await res.json()) as T;
}

export interface AuthResult {
  token: string;
  user: { id: number; firstName: string | null; tz: string };
  hasProfile: boolean;
  profile: Profile | null;
  plan: "free" | "pro";
  isAdmin: boolean;
}

export async function authorize(): Promise<AuthResult> {
  const initData = getRawInitData();
  const res = await request<AuthResult>("/api/auth/telegram", {
    method: "POST",
    body: JSON.stringify({ initData })
  });
  token = res.token;
  return res;
}

/** Ссылка на фото приёма. Подпись приходит с самим приёмом и живёт час. */
export function photoUrl(meal: { id: number; photoToken: string | null }, thumb = false): string {
  return `/api/photos/${meal.id}?t=${encodeURIComponent(meal.photoToken ?? "")}${thumb ? "&thumb=1" : ""}`;
}

export const api = {
  me: () => request<MeResponse>("/api/me"),
  diets: () => request<{ diets: DietPreset[] }>("/api/diets"),
  challenges: () => request<ChallengesResponse>("/api/challenges"),
  challengeFeasibility: (template: string) =>
    request<Feasibility>(`/api/challenges/feasibility?template=${encodeURIComponent(template)}`),
  startChallenge: (template: string, value?: number) =>
    request<{ id: number; joinCode: string; startDate: string }>("/api/challenges", {
      method: "POST",
      body: JSON.stringify({ template, value })
    }),
  quitChallenge: (id: number) => request<{ ok: true }>(`/api/challenges/${id}`, { method: "DELETE" }),
  recipes: () => request<{ recipes: Recipe[] }>("/api/recipes"),
  saveRecipe: (mealId: number, name?: string) =>
    request<{ recipe: Recipe; updated: boolean }>("/api/recipes", {
      method: "POST",
      body: JSON.stringify({ mealId, name })
    }),
  logRecipe: (id: number, multiplier: number) =>
    request<{ meal: Meal }>(`/api/recipes/${id}/log`, { method: "POST", body: JSON.stringify({ multiplier }) }),
  renameRecipe: (id: number, name: string) =>
    request<{ recipe: Recipe }>(`/api/recipes/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteRecipe: (id: number) => request<{ ok: true }>(`/api/recipes/${id}`, { method: "DELETE" }),
  accountSummary: () =>
    request<{ meals: number; advices: number; hasProfile: boolean; createdAt: string }>("/api/me/summary"),
  deleteAccount: () => request<{ ok: true }>("/api/me", { method: "DELETE" }),
  saveProfile: (profile: Partial<Profile> & { tz?: string }) =>
    request<{ profile: Profile; computedNorms: { targetKcal: number; targetProtein: number; targetFat: number; targetCarbs: number } }>(
      "/api/profile",
      { method: "PUT", body: JSON.stringify(profile) }
    ),
  day: (date?: string) => request<DayResponse>(`/api/day${date ? `?date=${date}` : ""}`),
  meal: (id: number) => request<{ meal: Meal }>(`/api/meals/${id}`),
  updateMealTime: (mealId: number, eatenAt: string) =>
    request<{ meal: Meal }>(`/api/meals/${mealId}`, { method: "PATCH", body: JSON.stringify({ eatenAt }) }),
  updateGrams: (mealId: number, itemId: number, grams: number) =>
    request<{ meal: Meal }>(`/api/meals/${mealId}/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ grams }) }),
  deleteItem: (mealId: number, itemId: number) =>
    request<{ meal: Meal | null }>(`/api/meals/${mealId}/items/${itemId}`, { method: "DELETE" }),
  addItemByText: (mealId: number, text: string) =>
    request<{ meal: Meal }>(`/api/meals/${mealId}/items`, { method: "POST", body: JSON.stringify({ text }) }),
  deleteMeal: (mealId: number) => request<{ ok: boolean }>(`/api/meals/${mealId}`, { method: "DELETE" }),
  analytics: (period: "week" | "month") => request<AnalyticsResponse>(`/api/analytics?period=${period}`),
  subscription: () => request<SubscriptionResponse>("/api/subscription"),
  invoice: (plan: "month" | "year") =>
    request<{ link: string }>("/api/subscription/invoice", { method: "POST", body: JSON.stringify({ plan }) }),

  admin: {
    overview: () => request<AdminOverview>("/api/admin/overview"),
    users: (query?: string) =>
      request<{ users: AdminUser[]; usdRubRate: number }>(`/api/admin/users${query ? `?query=${encodeURIComponent(query)}` : ""}`),
    grantPro: (userId: number, days: number) =>
      request<{ ok: boolean; expiresAt: string }>(`/api/admin/users/${userId}/pro`, { method: "POST", body: JSON.stringify({ days }) }),
    revokePro: (userId: number) => request<{ ok: boolean }>(`/api/admin/users/${userId}/pro`, { method: "DELETE" }),
    setLimit: (userId: number, limit: number | null) =>
      request<{ ok: boolean }>(`/api/admin/users/${userId}/limit`, { method: "POST", body: JSON.stringify({ limit }) }),
    userUsage: (userId: number) => request<{ usdRubRate: number; usage: AdminUsageRow[] }>(`/api/admin/users/${userId}/usage`),
    broadcast: (text: string, afterId?: number) =>
      request<{ ok: boolean; sent: number; failed: number; nextAfterId: number | null }>("/api/admin/broadcast", {
        method: "POST",
        body: JSON.stringify({ text, afterId })
      })
  }
};
