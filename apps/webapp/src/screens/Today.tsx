import { useCallback, useEffect, useState } from "react";
import { api, photoUrl } from "../api";
import type { DayResponse, Profile } from "../types";
import { ProgressRing } from "../components/ProgressRing";
import { SwipeRow } from "../components/SwipeRow";
import { MealDetail } from "./MealDetail";
import { haptic } from "../telegram";

interface Props {
  profile: Profile | null;
  initialMealId?: number;
  userName?: string | null;
}

function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return new Intl.DateTimeFormat("en-CA").format(d);
}

const dayCache = new Map<string, DayResponse>();

export function Today({ profile, initialMealId, userName }: Props) {
  const [date, setDate] = useState(todayStr());
  const [day, setDay] = useState<DayResponse | null>(dayCache.get(todayStr()) ?? null);
  const [openMeal, setOpenMeal] = useState<number | null>(initialMealId ?? null);
  const [loading, setLoading] = useState(!dayCache.has(todayStr()));

  const load = useCallback((d: string, silent = false) => {
    if (!silent && !dayCache.has(d)) setLoading(true);
    const cached = dayCache.get(d);
    if (cached) setDay(cached); // мгновенный показ из кэша, ниже — фоновое обновление
    api
      .day(d)
      .then((res) => {
        dayCache.set(d, res);
        setDay(res);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(date), [date, load]);

  // Возврат в приложение (после отправки фото боту) — тихо обновляем день
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load(date, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [date, load]);

  async function removeMeal(mealId: number) {
    haptic("light");
    // Оптимистично: убираем запись сразу, сервер догоняет
    setDay((prev) =>
      prev
        ? {
            ...prev,
            meals: prev.meals.filter((m) => m.id !== mealId)
          }
        : prev
    );
    try {
      await api.deleteMeal(mealId);
      haptic("success");
      load(date, true);
    } catch {
      haptic("error");
      load(date, true);
    }
  }

  const t = day?.totals;
  const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const isToday = date === todayStr();
  const dateLabel = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${date}T12:00:00`)
  );

  return (
    <div className="screen">
      <h1>{isToday && userName ? `Привет, ${userName}! 👋` : "Дневник"}</h1>
      <div className="row spread mb">
        <button className="chip date-nav" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
        <span className="hint" style={{ textTransform: "capitalize" }}>
          {isToday ? "Сегодня" : dateLabel}
        </span>
        <button className="chip date-nav" disabled={isToday} onClick={() => setDate(shiftDate(date, 1))}>›</button>
      </div>

      <div className="card hero">
        <div className="rings">
          <ProgressRing value={t?.totalKcal ?? 0} target={profile?.targetKcal ?? null} label="Ккал" unit="ккал" color="var(--brand)" />
          <ProgressRing value={t?.totalProtein ?? 0} target={profile?.targetProtein ?? null} label="Белки" unit="г" color="var(--protein)" />
          <ProgressRing value={t?.totalFat ?? 0} target={profile?.targetFat ?? null} label="Жиры" unit="г" color="var(--fat)" />
          <ProgressRing value={t?.totalCarbs ?? 0} target={profile?.targetCarbs ?? null} label="Углеводы" unit="г" color="var(--carbs)" />
        </div>
      </div>

      <div className="card">
        <div className="row spread mb">
          <h2 style={{ margin: 0 }}>Приёмы пищи</h2>
          {day && day.meals.length > 0 && <span className="hint small">свайп влево — действия</span>}
        </div>
        {loading && !day ? (
          <>
            <div className="skeleton-row" />
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </>
        ) : !day || day.meals.length === 0 ? (
          <div className="empty-state">
            <div className="empty-emoji">📸</div>
            <p className="hint">
              {isToday ? "Пока пусто. Пришли боту фото еды — запись появится здесь." : "В этот день записей не было."}
            </p>
          </div>
        ) : (
          day.meals.map((m) => (
            <SwipeRow key={m.id} onTap={() => setOpenMeal(m.id)} onEdit={() => setOpenMeal(m.id)} onDelete={() => void removeMeal(m.id)}>
              <div className="meal-row">
                {m.hasPhoto ? (
                  <img
                    className="meal-thumb"
                    src={photoUrl(m, true)}
                    alt=""
                    loading="lazy"
                    onError={(e) => ((e.target as HTMLImageElement).outerHTML = '<div class="meal-thumb">🍽</div>')}
                  />
                ) : (
                  <div className="meal-thumb">{m.source === "text" ? "💬" : "🍽"}</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row spread">
                    <b>{timeFmt.format(new Date(m.eatenAt))}</b>
                    <b className="progress-badge">{Math.round(m.totalKcal)} ккал</b>
                  </div>
                  <p className="hint small ellipsis">{m.items.map((i) => i.dish).join(", ")}</p>
                </div>
              </div>
            </SwipeRow>
          ))
        )}
      </div>

      {openMeal !== null && (
        <MealDetail
          mealId={openMeal}
          onClose={(changed) => {
            setOpenMeal(null);
            if (changed) load(date, true);
          }}
        />
      )}
    </div>
  );
}
