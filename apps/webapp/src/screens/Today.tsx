import { useCallback, useEffect, useState } from "react";
import { api, photoUrl } from "../api";
import type { DayResponse, Profile } from "../types";
import { ProgressRing } from "../components/ProgressRing";
import { MealDetail } from "./MealDetail";

interface Props {
  profile: Profile | null;
  initialMealId?: number;
  userName?: string | null;
}

export function Today({ profile, initialMealId, userName }: Props) {
  const [day, setDay] = useState<DayResponse | null>(null);
  const [openMeal, setOpenMeal] = useState<number | null>(initialMealId ?? null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .day()
      .then(setDay)
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const t = day?.totals;
  const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

  const dateLabel = day?.date
    ? new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day.date}T12:00:00`))
    : "";

  return (
    <div className="screen">
      <h1>{userName ? `Привет, ${userName}! 👋` : "Сегодня"}</h1>
      <p className="hint mb" style={{ textTransform: "capitalize" }}>{dateLabel}</p>

      <div className="card">
        <div className="rings">
          <ProgressRing value={t?.totalKcal ?? 0} target={profile?.targetKcal ?? null} label="Ккал" unit="ккал" color="var(--tg-button)" />
          <ProgressRing value={t?.totalProtein ?? 0} target={profile?.targetProtein ?? null} label="Белки" unit="г" color="var(--protein)" />
          <ProgressRing value={t?.totalFat ?? 0} target={profile?.targetFat ?? null} label="Жиры" unit="г" color="var(--fat)" />
          <ProgressRing value={t?.totalCarbs ?? 0} target={profile?.targetCarbs ?? null} label="Углеводы" unit="г" color="var(--carbs)" />
        </div>
      </div>

      <div className="card">
        <h2>Приёмы пищи</h2>
        {loading ? (
          <div className="spinner" />
        ) : !day || day.meals.length === 0 ? (
          <p className="hint">Пока пусто. Пришли боту фото еды — запись появится здесь 📸</p>
        ) : (
          day.meals.map((m) => (
            <div className="meal-row" key={m.id} onClick={() => setOpenMeal(m.id)}>
              {m.hasPhoto ? (
                <img className="meal-thumb" src={photoUrl(m.id)} alt="" onError={(e) => ((e.target as HTMLImageElement).outerHTML = '<div class="meal-thumb">🍽</div>')} />
              ) : (
                <div className="meal-thumb">{m.source === "text" ? "💬" : "🍽"}</div>
              )}
              <div style={{ flex: 1 }}>
                <div className="row spread">
                  <b>{timeFmt.format(new Date(m.eatenAt))}</b>
                  <b className="progress-badge">{Math.round(m.totalKcal)} ккал</b>
                </div>
                <p className="hint small">{m.items.map((i) => i.dish).join(", ")}</p>
              </div>
            </div>
          ))
        )}
      </div>

      {openMeal !== null && (
        <MealDetail
          mealId={openMeal}
          onClose={(changed) => {
            setOpenMeal(null);
            if (changed) load();
          }}
        />
      )}
    </div>
  );
}
