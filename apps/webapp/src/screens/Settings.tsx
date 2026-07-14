import { useState } from "react";
import { api } from "../api";
import type { Profile } from "../types";
import { parseNum } from "./Onboarding";

interface Props {
  profile: Profile;
  onSaved: (p: Profile) => void;
}

const TONES: Array<{ v: Profile["adviceTone"]; l: string }> = [
  { v: "strict", l: "Строгий" },
  { v: "friendly", l: "Дружелюбный" },
  { v: "scientific", l: "Научный" }
];

type NumKey = "birthYear" | "heightCm" | "weightKg" | "targetKcal" | "targetProtein" | "targetFat" | "targetCarbs";

export function Settings({ profile, onSaved }: Props) {
  const [p, setP] = useState<Profile>(profile);
  // Числовые поля храним строками: пустое поле остаётся пустым (Number("") === 0 давал «прилипающий 0»)
  const [nums, setNums] = useState<Record<NumKey, string>>({
    birthYear: profile.birthYear?.toString() ?? "",
    heightCm: profile.heightCm?.toString() ?? "",
    weightKg: profile.weightKg?.toString() ?? "",
    targetKcal: profile.targetKcal?.toString() ?? "",
    targetProtein: profile.targetProtein?.toString() ?? "",
    targetFat: profile.targetFat?.toString() ?? "",
    targetCarbs: profile.targetCarbs?.toString() ?? ""
  });
  const [manualTargets, setManualTargets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function upd<K extends keyof Profile>(key: K, value: Profile[K]) {
    setP((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function updNum(key: NumKey, value: string) {
    setNums((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function save() {
    const year = parseNum(nums.birthYear);
    const height = parseNum(nums.heightCm);
    const weight = parseNum(nums.weightKg);
    if (!(year >= 1930 && year <= 2018 && height >= 120 && height <= 230 && weight >= 35 && weight <= 300)) {
      setError("Проверьте год рождения, рост и вес — что-то не заполнено или вне разумных пределов.");
      return;
    }
    const target = (key: NumKey) => {
      if (!manualTargets) return null; // бэкенд пересчитает нормы сам
      const n = parseNum(nums[key]);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    };
    setSaving(true);
    setError("");
    try {
      const res = await api.saveProfile({
        ...p,
        birthYear: year,
        heightCm: Math.round(height),
        weightKg: weight,
        targetKcal: target("targetKcal"),
        targetProtein: target("targetProtein"),
        targetFat: target("targetFat"),
        targetCarbs: target("targetCarbs")
      });
      setP(res.profile);
      setNums((prev) => ({
        ...prev,
        targetKcal: res.profile.targetKcal?.toString() ?? "",
        targetProtein: res.profile.targetProtein?.toString() ?? "",
        targetFat: res.profile.targetFat?.toString() ?? "",
        targetCarbs: res.profile.targetCarbs?.toString() ?? ""
      }));
      onSaved(res.profile);
      setSaved(true);
    } catch {
      setError("Не удалось сохранить настройки");
    } finally {
      setSaving(false);
    }
  }

  const numField = (label: string, key: "birthYear" | "heightCm" | "weightKg") => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode={key === "weightKg" ? "decimal" : "numeric"}
        value={nums[key]}
        onChange={(e) => updNum(key, e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
    </label>
  );

  return (
    <div className="screen">
      <h1>Настройки</h1>

      <div className="card">
        <h2>Профиль</h2>
        <div className="row mb">
          <button className={`chip ${p.gender === "male" ? "active" : ""}`} onClick={() => upd("gender", "male")}>Мужчина</button>
          <button className={`chip ${p.gender === "female" ? "active" : ""}`} onClick={() => upd("gender", "female")}>Женщина</button>
        </div>
        {numField("Год рождения", "birthYear")}
        {numField("Рост, см", "heightCm")}
        {numField("Вес, кг", "weightKg")}
        <label className="field">
          <span>Активность</span>
          <select value={p.activityLevel} onChange={(e) => upd("activityLevel", e.target.value as Profile["activityLevel"])}>
            <option value="sedentary">Сидячая</option>
            <option value="light">Лёгкая</option>
            <option value="moderate">Умеренная</option>
            <option value="high">Высокая</option>
          </select>
        </label>
        <label className="field">
          <span>Цель</span>
          <select value={p.goal} onChange={(e) => upd("goal", e.target.value as Profile["goal"])}>
            <option value="lose">Похудеть</option>
            <option value="maintain">Поддерживать вес</option>
            <option value="gain">Набрать массу</option>
          </select>
        </label>
        <label className="field">
          <span>Тип питания</span>
          <select value={p.dietType} onChange={(e) => upd("dietType", e.target.value as Profile["dietType"])}>
            <option value="none">Обычный</option>
            <option value="vegetarian">Вегетарианский</option>
            <option value="vegan">Веганский</option>
            <option value="keto">Кето</option>
            <option value="halal">Халяль</option>
          </select>
        </label>
        <label className="field">
          <span>Аллергии (через запятую)</span>
          <input type="text" value={p.allergies.join(", ")} onChange={(e) => upd("allergies", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        </label>
        <label className="field">
          <span>Не люблю (через запятую) — бот не будет это советовать</span>
          <input type="text" value={p.dislikes.join(", ")} onChange={(e) => upd("dislikes", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        </label>
      </div>

      <div className="card">
        <h2>Советы нутрициолога</h2>
        <p className="hint small mb">Тон советов</p>
        <div className="row wrap mb">
          {TONES.map((t) => (
            <button key={t.v} className={`chip ${p.adviceTone === t.v ? "active" : ""}`} onClick={() => upd("adviceTone", t.v)}>{t.l}</button>
          ))}
        </div>
        <label className="field">
          <span>Время ежедневного совета</span>
          <input type="time" value={p.adviceTime} onChange={(e) => upd("adviceTime", e.target.value)} />
        </label>
        <label className="row" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={p.adviceEnabled} onChange={(e) => upd("adviceEnabled", e.target.checked)} style={{ width: 20, height: 20 }} />
          <span>Присылать советы</span>
        </label>
      </div>

      <div className="card">
        <div className="row spread mb">
          <h2>Цели КБЖУ</h2>
          <label className="row" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={manualTargets} onChange={(e) => setManualTargets(e.target.checked)} style={{ width: 20, height: 20 }} />
            <span className="hint small">вручную</span>
          </label>
        </div>
        {manualTargets ? (
          <>
            <label className="field"><span>Калории</span>
              <input type="number" inputMode="numeric" value={nums.targetKcal} onChange={(e) => updNum("targetKcal", e.target.value)} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="row">
              <label className="field" style={{ flex: 1 }}><span>Белки, г</span>
                <input type="number" inputMode="numeric" value={nums.targetProtein} onChange={(e) => updNum("targetProtein", e.target.value)} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <label className="field" style={{ flex: 1 }}><span>Жиры, г</span>
                <input type="number" inputMode="numeric" value={nums.targetFat} onChange={(e) => updNum("targetFat", e.target.value)} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <label className="field" style={{ flex: 1 }}><span>Углеводы, г</span>
                <input type="number" inputMode="numeric" value={nums.targetCarbs} onChange={(e) => updNum("targetCarbs", e.target.value)} onFocus={(e) => e.currentTarget.select()} />
              </label>
            </div>
          </>
        ) : (
          <p className="hint small">
            Сейчас: {p.targetKcal ?? "?"} ккал · Б {p.targetProtein ?? "?"} / Ж {p.targetFat ?? "?"} / У {p.targetCarbs ?? "?"}.
            При сохранении нормы пересчитаются автоматически по формуле Миффлина-Сан Жеора.
          </p>
        )}
      </div>

      {error && <p className="hint mb" style={{ color: "#e53935" }}>{error}</p>}
      <button className="btn" disabled={saving} onClick={() => void save()}>
        {saving ? "Сохраняю…" : saved ? "Сохранено ✓" : "Сохранить"}
      </button>
    </div>
  );
}
