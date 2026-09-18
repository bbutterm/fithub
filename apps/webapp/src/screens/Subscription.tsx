import { useEffect, useState } from "react";
import { api } from "../api";
import type { SubscriptionResponse } from "../types";

export function Subscription({ onBack }: { onBack: () => void }) {
  const [sub, setSub] = useState<SubscriptionResponse | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    api.subscription().then(r => { if (active) setSub(r); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return <div className="screen">
    <button className="chip mb" onClick={onBack}>← В профиль</button>
    <h1>Premium</h1>
    <section className="card premium-placeholder">
      <span className="status-pill">Покупки приостановлены</span>
      <h2>Пока без покупок</h2>
      <p className="hint">Оформление и продление подписки временно недоступны. Здесь нет оплаты и списаний.</p>
      <p className="hint mt">Продолжай вести дневник в рамках своего текущего тарифа. Действующая подписка сохраняется до окончания её срока.</p>
    </section>
    <section className="card" aria-live="polite">
      <h2>Текущий тариф</h2>
      {error ? <><p role="alert" className="hint mb">Не удалось загрузить статус подписки.</p><button className="chip" onClick={() => setAttempt(x => x + 1)}>Повторить</button></> : sub ? <>
        <b>{sub.plan === "pro" ? "Pro активен" : "Бесплатный"}</b>
        {sub.plan === "pro" ? <p className="hint mt">До {sub.expiresAt ? new Date(sub.expiresAt).toLocaleDateString("ru-RU") : "—"}</p> : <p className="hint mt">Распознаваний сегодня: {sub.usedToday} из {sub.freeLimit}</p>}
      </> : <p className="hint">Загружаем статус…</p>}
    </section>
  </div>;
}
