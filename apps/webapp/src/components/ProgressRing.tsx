interface Props {
  value: number;
  target: number | null;
  label: string;
  unit: string;
  color: string;
  size?: number;
}

export function ProgressRing({ value, target, label, unit, color, size = 74 }: Props) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = target && target > 0 ? Math.max(0, Math.min(1, value / target)) : 0;
  const over = target !== null && target > 0 && value > target;

  return (
    <div className="progress-ring">
      <svg role="img" aria-label={`${label}: ${Math.round(value)} ${unit}${target ? ` из ${target} ${unit}` : ""}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="color-mix(in srgb, var(--tg-hint) 25%, transparent)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={over ? "var(--over)" : color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="46%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size / 5}
          fontWeight={700}
          fill="var(--tg-text)"
        >
          {Math.round(value)}
        </text>
        <text x="50%" y="66%" textAnchor="middle" fontSize={size / 8} fill="var(--tg-hint)">
          {target ? `/ ${target}` : unit}
        </text>
      </svg>
      <div className="ring-label">{label}</div>
    </div>
  );
}
