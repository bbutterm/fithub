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

export function Onboarding({ onDone }: Props) {
  const [step, setStep] = useState(0);
  const [gender, setGender] = useState<"male" | "female">("male");
  const [birthYear, setBirthYear] = useState(1995);
  const [heightCm, setHeightCm] = useState(175);
  const [weightKg, setWeightKg] = useState(75);
  const [activityLevel, setActivityLevel] = useState<Profile["activityLevel"]>("moderate");
  const [goal, setGoal] = useState<Profile["goal"]>("maintain");
  const [dietType, setDietType] = useState<Profile["dietType"]>("none");
  const [allergies, setAllergies] = useState("");
  const [saving, setSaving] = useState(false);
  const [norms, setNorms] = useState<{ targetKcal: number; targetProtein: number; targetFat: number; targetCarbs: number } | null>(null);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await api.saveProfile({
        gender,
        birthYear,
        heightCm,
        weightKg,
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
        <input type="number" value={birthYear} min={1930} max={2018} onChange={(e) => setBirthYear(Number(e.target.value))} />
      </label>
      <label className="field"><span>Рост, см</span>
        <input type="number" value={heightCm} min={120} max={230} onChange={(e) => setHeightCm(Number(e.target.value))} />
      </label>
      <label className="field"><span>Вес, кг</span>
        <input type="number" value={weightKg} min={35} max={300} onChange={(e) => setWeightKg(Number(e.target.value))} />
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
          <button className="btn" onClick={() => setStep(step + 1)}>Дальше</button>
        ) : (
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? "Считаю нормы…" : "Рассчитать нормы"}
          </button>
        )}
      </div>
    </div>
  );
}
