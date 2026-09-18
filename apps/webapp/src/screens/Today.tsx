import { useCallback, useEffect, useRef, useState } from "react";
import { api, photoUrl } from "../api";
import type { DayResponse, Profile } from "../types";
import { ProgressRing } from "../components/ProgressRing";
import { SwipeRow } from "../components/SwipeRow";
import { MealDetail } from "./MealDetail";
import { closeToBot, haptic } from "../telegram";

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

  const [error, setError] = useState("");
  const sequence = useRef(0);
  const selectedDate = useRef(date);
  selectedDate.current = date;

  const load = useCallback((d: string, silent = false) => {
    // A mutation started on another day must not replace the visible day.
    if (d !== selectedDate.current) return;
    const seq = ++sequence.current;
    setError("");
    if (!silent) setLoading(!dayCache.has(d));
    const cached = dayCache.get(d);
    if (!silent) setDay(cached ?? null);
    api
      .day(d)
      .then((res) => {
        dayCache.set(d, res);
        if (seq === sequence.current) setDay(res);
      })
      .catch(() => { if (seq === sequence.current) setError("Не удалось обновить дневник. Проверь соединение и повтори."); })
      .finally(() => { if (seq === sequence.current) setLoading(false); });
  }, []);

  useEffect(() => { load(date); return () => { sequence.current++; }; }, [date, load]);

  // Возврат в приложение (после отправки фото боту) — тихо обновляем день
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load(date, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [date, load]);

  async function removeMeal(mealId: number) {
    if (!window.confirm("Удалить приём пищи? Это действие нельзя отменить.")) return;
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
  const remaining = profile?.targetKcal ? profile.targetKcal - (t?.totalKcal ?? 0) : null;
  const dateLabel = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${date}T12:00:00`)
  );

  return (
    <div className="screen">
      <h1>{isToday && userName ? `Привет, ${userName}! 👋` : "Дневник"}</h1>
      <div className="row spread mb">
        <button aria-label="Предыдущий день" className="chip date-nav" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
        <span className="hint" style={{ textTransform: "capitalize" }}>
          {isToday ? `Сегодня · ${new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}` : dateLabel}
        </span>
        <button aria-label="Следующий день" className="chip date-nav" disabled={isToday} onClick={() => setDate(shiftDate(date, 1))}>›</button>
      </div>

      {!isToday && <button className="chip mb" onClick={() => setDate(todayStr())}>Вернуться к сегодня</button>}
      {error && <div className="card error-state" role="alert"><p>{error}</p><button className="chip mt" onClick={() => load(date)}>Повторить</button></div>}
      <section className="card hero nutrition-card" aria-busy={loading}>
        <div className="row spread mb"><h2>Баланс дня</h2><span className="hint small">{isToday ? "Сегодня" : "Выбранный день"}</span></div>
        {loading && !day ? <div className="skeleton-row" aria-label="Загружаем баланс" /> : error && !day ? <p className="hint mb">Баланс пока недоступен</p> : <>
          <div className="calorie-summary">
            <ProgressRing value={t?.totalKcal ?? 0} target={profile?.targetKcal ?? null} label="Калории, ккал" unit="ккал" color="var(--brand)" size={116} />
            <div><p className="eyebrow">Твой ориентир</p><b className="balance-value">{remaining === null ? "Цель не задана" : `${Math.round(Math.abs(remaining))} ккал`}</b><p className="hint">{remaining === null ? "Задай её в профиле" : remaining >= 0 ? "до дневной цели" : "выше дневной цели"}</p><p className="hint small mt">Один день не определяет результат</p></div>
          </div>
          <div className="macro-rings rings">
            <ProgressRing value={t?.totalProtein ?? 0} target={profile?.targetProtein ?? null} label="Белки, г" unit="г" color="var(--protein)" size={86} />
            <ProgressRing value={t?.totalFat ?? 0} target={profile?.targetFat ?? null} label="Жиры, г" unit="г" color="var(--fat)" size={86} />
            <ProgressRing value={t?.totalCarbs ?? 0} target={profile?.targetCarbs ?? null} label="Углеводы, г" unit="г" color="var(--carbs)" size={86} />
          </div>
        </>}
        <button className="btn hero-action" onClick={closeToBot}>Добавить еду в чате ↗</button>
        <p className="hint small hero-note">Закрой Mini App и отправь боту фото или описание еды</p>
      </section>

      <div className="card">
        <div className="row spread mb">
          <h2 style={{ margin: 0 }}>Приёмы пищи</h2>
          {day && day.meals.length > 0 && <span className="hint small">Записей: {day.meals.length}</span>}
        </div>
        {loading && !day ? (
          <>
            <div className="skeleton-row" />
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </>
        ) : error && !day ? <p className="hint">Записи не загружены.</p> : !day || day.meals.length === 0 ? (
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
                  <p className="meal-title">{m.items.map((i) => i.dish).join(", ")}</p>
                  <p className="hint small">Б {Math.round(m.totalProtein)} · Ж {Math.round(m.totalFat)} · У {Math.round(m.totalCarbs)} г</p>
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
