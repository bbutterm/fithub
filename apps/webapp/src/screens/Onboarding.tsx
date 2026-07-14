import { useState } from "react";
import { api } from "../api";
import type { Profile } from "../types";

interface Props {
  onDone: (profile: Profile) => void;
}

const ACTIVITY: Array<{ v: Profile["activityLevel"]; l: string }> = [
  { v: "sedentary", l: "Сидячий" },
  { v: "light", l: "Лёгкая" },
  { v: "moderate", l: "Умеренная" },
  { v: "high", l: "Высокая" }
];
const GOALS: Array<{ v: Profile["goal"]; l: string }> = [
  { v: "lose", l: "Похудеть" },
  { v: "maintain", l: "Поддерживать" },
  { v: "gain", l: "Набрать массу" }
];
const DIETS: Array<{ v: Profile["dietType"]; l: string }> = [
  { v: "none", l: "Обычная" },
  { v: "vegetarian", l: "Вегетарианская" },
  { v: "vegan", l: "Веганская" },
  { v: "keto", l: "Кето" },
  { v: "halal", l: "Халяль" }
];

/** Пустая строка остаётся пустой (Number("") === 0 превращал очищенное поле в неубираемый ноль). */
export function parseNum(s: string): number {
  const t = s.trim().replace(",", ".");
  return t === "" ? NaN : Number(t);
}

export function Onboarding({ onDone }: Props) {
  const [step, setStep] = useState(0);
  const [gender, setGender] = useState<"male" | "female">("male");
  // Числовые поля храним строками: state-число + Number(e.target.value) давали «прилипающий 0»
  const [birthYear, setBirthYear] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [activityLevel, setActivityLevel] = useState<Profile["activityLevel"]>("moderate");
  const [goal, setGoal] = useState<Profile["goal"]>("maintain");
  const [dietType, setDietType] = useState<Profile["dietType"]>("none");
  const [allergies, setAllergies] = useState("");
  const [saving, setSaving] = useState(false);
  const [norms, setNorms] = useState<{ targetKcal: number; targetProtein: number; targetFat: number; targetCarbs: number } | null>(null);
  const [error, setError] = useState("");

  const year = parseNum(birthYear);
  const height = parseNum(heightCm);
  const weight = parseNum(weightKg);
  const step0Valid =
    year >= 1930 && year <= 2018 && height >= 120 && height <= 230 && weight >= 35 && weight <= 300;

  async function save() {
    setSaving(true);
    setError("");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await api.saveProfile({
        gender,
        birthYear: year,
        heightCm: Math.round(height),
        weightKg: weight,
        activityLevel,
        goal,
        dietType,
        allergies: allergies.split(",").map((s) => s.trim()).filter(Boolean),
        dislikes: [],
        tz
      });
      setNorms(res.computedNorms);
      setTimeout(() => onDone(res.profile), 1800);
    } catch {
      setError("Не получилось сохранить. Попробуйте ещё раз.");
      setSaving(false);
    }
  }

  if (norms) {
    return (
      <div className="screen center">
        <div className="card" style={{ marginTop: 60 }}>
          <h1>Готово! 🎉</h1>
          <p className="mt">
            Твоя норма: <b>{norms.targetKcal} ккал</b>
            <br />
            Белки {norms.targetProtein} г · Жиры {norms.targetFat} г · Углеводы {norms.targetCarbs} г
          </p>
          <p className="hint mt">Теперь пришли боту фото первой еды 📸</p>
        </div>
      </div>
    );
  }

  const steps = [
    <div key="s0" className="card">
      <h2>О тебе</h2>
      <div className="row mb">
        <button className={`chip ${gender === "male" ? "active" : ""}`} onClick={() => setGender("male")}>Мужчина</button>
        <button className={`chip ${gender === "female" ? "active" : ""}`} onClick={() => setGender("female")}>Женщина</button>
      </div>
      <label className="field"><span>Год рождения</span>
        <input type="number" inputMode="numeric" placeholder="1995" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <label className="field"><span>Рост, см</span>
        <input type="number" inputMode="numeric" placeholder="175" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <label className="field"><span>Вес, кг</span>
        <input type="number" inputMode="decimal" placeholder="75" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </label>
    </div>,
    <div key="s1" className="card">
      <h2>Активность и цель</h2>
      <p className="hint small mb">Активность</p>
      <div className="row wrap mb">
        {ACTIVITY.map((a) => (
          <button key={a.v} className={`chip ${activityLevel === a.v ? "active" : ""}`} onClick={() => setActivityLevel(a.v)}>{a.l}</button>
        ))}
      </div>
      <p className="hint small mb">Цель</p>
      <div className="row wrap">
        {GOALS.map((g) => (
          <button key={g.v} className={`chip ${goal === g.v ? "active" : ""}`} onClick={() => setGoal(g.v)}>{g.l}</button>
        ))}
      </div>
    </div>,
    <div key="s2" className="card">
      <h2>Питание</h2>
      <p className="hint small mb">Тип питания</p>
      <div className="row wrap mb">
        {DIETS.map((d) => (
          <button key={d.v} className={`chip ${dietType === d.v ? "active" : ""}`} onClick={() => setDietType(d.v)}>{d.l}</button>
        ))}
      </div>
      <label className="field"><span>Аллергии (через запятую, можно пропустить)</span>
        <input type="text" value={allergies} placeholder="арахис, молоко…" onChange={(e) => setAllergies(e.target.value)} />
      </label>
    </div>
  ];

  return (
    <div className="screen">
      <h1>Настроим твоего нутрициолога</h1>
      <p className="hint mb">Шаг {step + 1} из {steps.length}</p>
      {steps[step]}
      {error && <p className="hint mb" style={{ color: "#e53935" }}>{error}</p>}
      <div className="row">
        {step > 0 && (
          <button className="btn secondary" onClick={() => setStep(step - 1)}>Назад</button>
        )}
        {step < steps.length - 1 ? (
          <button className="btn" disabled={step === 0 && !step0Valid} onClick={() => setStep(step + 1)}>Дальше</button>
        ) : (
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? "Считаю нормы…" : "Рассчитать нормы"}
          </button>
        )}
      </div>
    </div>
  );
}
