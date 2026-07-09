interface Props {
  days: Array<{ date: string; kcal: number }>;
  target: number | null;
}

/** Простые CSS-бары калорийности по дням, без chart-библиотек. */
export function BarChart({ days, target }: Props) {
  const max = Math.max(target ?? 0, ...days.map((d) => d.kcal), 1);
  const showEvery = days.length > 10 ? 5 : 1;
  return (
    <div>
      <div className="chart">
        {days.map((d, i) => (
          <div className="bar-col" key={d.date} title={`${d.date}: ${d.kcal} ккал`}>
            <div
              className={`bar${target && d.kcal > target ? " over" : ""}`}
              style={{ height: `${Math.round((d.kcal / max) * 100)}%` }}
            />
            <div className="bar-date">{i % showEvery === 0 ? d.date.slice(8) : " "}</div>
          </div>
        ))}
      </div>
      {target ? (
        <div className="hint small mt">
          Цель: {target} ккал/день · <span style={{ color: "var(--over)", fontWeight: 600 }}>красные</span> дни — превышение
        </div>
      ) : null}
    </div>
  );
}
