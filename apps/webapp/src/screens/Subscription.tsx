import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { SubscriptionResponse } from "../types";
import { openInvoice } from "../telegram";

const FEATURES: Array<{ name: string; free: string; pro: string }> = [
  { name: "Распознаваний в день", free: "3", pro: "Безлимит" },
  { name: "Советы нутрициолога", free: "2 раза в неделю", pro: "Каждый день" },
  { name: "Аналитика", free: "Неделя", pro: "Неделя и месяц" },
  { name: "Месячный отчёт с инсайтами", free: "—", pro: "✓" }
];

export function Subscription() {
  const [sub, setSub] = useState<SubscriptionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.subscription().then(setSub).catch(() => setError("Не удалось загрузить"));
  }, []);
  useEffect(load, [load]);

  async function buy(plan: "month" | "year") {
    setBusy(true);
    setError("");
    try {
      const { link } = await api.invoice(plan);
      openInvoice(link, () => setTimeout(load, 1500));
    } catch {
      setError("Не удалось создать счёт, попробуйте позже");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <h1>Подписка</h1>
      {!sub ? (
        <div className="spinner" />
      ) : (
        <>
          <div className="card">
            {sub.plan === "pro" ? (
              <>
                <h2>У тебя Pro ⭐</h2>
                <p className="hint">
                  Действует до {sub.expiresAt ? new Date(sub.expiresAt).toLocaleDateString("ru-RU") : "—"}. Продлить можно в любой момент — дни сложатся.
                </p>
              </>
            ) : (
              <>
                <h2>Бесплатный тариф</h2>
                <p className="hint">Сегодня использовано распознаваний: {sub.usedToday} из {sub.freeLimit}</p>
              </>
            )}
          </div>

          <div className="card">
            <h2>Free vs Pro</h2>
            {FEATURES.map((f) => (
              <div className="row spread mt" key={f.name}>
                <span className="hint small" style={{ flex: 1.4 }}>{f.name}</span>
                <span className="small" style={{ flex: 0.8, textAlign: "center" }}>{f.free}</span>
                <b className="small" style={{ flex: 0.9, textAlign: "right" }}>{f.pro}</b>
              </div>
            ))}
          </div>

          <button className="btn mb" disabled={busy} onClick={() => void buy("month")}>
            ⭐ Pro на месяц — {sub.prices.month} Stars
          </button>
          <button className="btn secondary" disabled={busy} onClick={() => void buy("year")}>
            ⭐ Pro на год — {sub.prices.year} Stars
          </button>
          {error && <p className="hint mt" style={{ color: "#e53935" }}>{error}</p>}
          <p className="hint small mt center">Оплата в Telegram Stars внутри приложения.</p>
        </>
      )}
    </div>
  );
}
