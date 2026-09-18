import { useEffect, useState } from "react";
import { RichText } from "../components/RichText";
import { api, ApiError } from "../api";
import type { AnalyticsResponse } from "../types";
import { BarChart } from "../components/BarChart";

interface Props {
  plan: "free" | "pro";
  onGoPro: () => void;
}

export function Analytics({ plan, onGoPro }: Props) {
  const [period, setPeriod] = useState<"week" | "month">("week");
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [proRequired, setProRequired] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setProRequired(false);
    api
      .analytics(period)
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && (e.code === "pro_required" || e.status === 402)) setProRequired(true);
      })
      .finally(() => setLoading(false));
  }, [period]);

  const avgRow = (label: string, avg: number, target: number | null, unit = "г") => (
    <div className="row spread" key={label}>
      <span className="hint">{label}</span>
      <b>
        {avg} {target ? <span className="hint">/ {target}</span> : null} {unit}
      </b>
    </div>
  );

  return (
    <div className="screen">
      <h1>Аналитика</h1>
      <div className="row mb mt">
        <button className={`chip ${period === "week" ? "active" : ""}`} onClick={() => setPeriod("week")}>Неделя</button>
        <button className={`chip ${period === "month" ? "active" : ""}`} onClick={() => setPeriod("month")}>
          Месяц {plan === "free" ? "🔒" : ""}
        </button>
      </div>

      {loading ? (
        <div className="spinner" />
      ) : proRequired ? (
        <div className="card center">
          <h2>Месячная аналитика — в Pro</h2>
          <p className="hint mb">Динамика за 30 дней, месячные отчёты нутрициолога и безлимит распознаваний.</p>
          <button className="btn" onClick={onGoPro}>Подключить Pro</button>
        </div>
      ) : data ? (
        <>
          <div className="card">
            <h2>Калории по дням</h2>
            <BarChart days={data.days} target={data.targets.kcal} />
          </div>
          <div className="card">
            <h2>Средние за {period === "week" ? "неделю" : "месяц"}</h2>
            {avgRow("Калории", data.averages.kcal, data.targets.kcal, "ккал")}
            {avgRow("Белки", data.averages.protein, data.targets.protein)}
            {avgRow("Жиры", data.averages.fat, data.targets.fat)}
            {avgRow("Углеводы", data.averages.carbs, data.targets.carbs)}
          </div>
          <div className="card row spread">
            <span>🔥 Стрик ведения дневника</span>
            <b>{data.streak} дн.</b>
          </div>
          {data.monthlyInsight && (
            <div className="card">
              <h2>Инсайты месяца</h2>
              <p className="hint small mb">{data.monthlyInsight.date.slice(0, 7)}</p>
              <RichText text={data.monthlyInsight.text} />
            </div>
          )}
        </>
      ) : (
        <p className="hint">Нет данных</p>
      )}
    </div>
  );
}
