import { useEffect, useRef, useState } from "react";
import { api, ApiError, photoUrl } from "../api";
import type { Meal } from "../types";

interface Props {
  mealId: number;
  onClose: (changed: boolean) => void;
}

const r0 = (v: number) => Math.round(v);

export function MealDetail({ mealId, onClose }: Props) {
  const [meal, setMeal] = useState<Meal | null>(null);
  const [loading, setLoading] = useState(true);
  const [grams, setGrams] = useState<Record<number, number>>({});
  const [addText, setAddText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const dismiss = useRef(() => onClose(changed));
  dismiss.current = () => { if (!busy) onClose(changed); };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss.current();
      if (e.key !== "Tab") return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);

  useEffect(() => {
    api
      .meal(mealId)
      .then((r) => {
        setMeal(r.meal);
        setGrams(Object.fromEntries(r.meal.items.map((i) => [i.id, i.grams])));
      })
      .catch(() => setError("Не удалось загрузить приём пищи"))
      .finally(() => setLoading(false));
  }, [mealId]);

  async function commitGrams(itemId: number, value: number) {
    if (!meal) return;
    setBusy(true);
    try {
      const r = await api.updateGrams(meal.id, itemId, value);
      setMeal(r.meal);
      setGrams(Object.fromEntries(r.meal.items.map((i) => [i.id, i.grams])));
      setChanged(true);
    } catch {
      setError("Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function changeTime(iso: string) {
    if (!meal) return;
    setBusy(true);
    try {
      const r = await api.updateMealTime(meal.id, iso);
      setMeal(r.meal);
      setChanged(true);
    } catch {
      setError("Не удалось изменить время");
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(itemId: number) {
    if (!meal) return;
    setBusy(true);
    try {
      const r = await api.deleteItem(meal.id, itemId);
      setChanged(true);
      if (!r.meal) return onClose(true); // удалили последнее блюдо — приём удалён целиком
      setMeal(r.meal);
      setGrams(Object.fromEntries(r.meal.items.map((i) => [i.id, i.grams])));
    } catch {
      setError("Не удалось удалить");
    } finally {
      setBusy(false);
    }
  }

  async function addItem() {
    if (!meal || addText.trim().length < 3) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.addItemByText(meal.id, addText.trim());
      setMeal(r.meal);
      setGrams(Object.fromEntries(r.meal.items.map((i) => [i.id, i.grams])));
      setAddText("");
      setChanged(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "no_food") setError("Не понял, что это за еда 🤔");
      else if (e instanceof ApiError && e.code === "limit_reached") setError("Дневной лимит распознаваний исчерпан");
      else setError("Не получилось добавить");
    } finally {
      setBusy(false);
    }
  }

  async function removeMeal() {
    if (!meal) return;
    if (!window.confirm("Удалить весь приём пищи? Это действие нельзя отменить.")) return;
    setBusy(true);
    try { await api.deleteMeal(meal.id); onClose(true); }
    catch { setError("Не удалось удалить приём. Попробуй ещё раз."); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={() => dismiss.current()}>
      <div ref={dialog} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-label="Приём пищи" onClick={(e) => e.stopPropagation()}>
        <div className="row spread mb"><h2>Приём пищи</h2><button className="chip" disabled={busy} onClick={() => dismiss.current()}>Закрыть</button></div>
        {loading ? (
          <div className="spinner" />
        ) : !meal ? (
          <p className="hint">{error || "Приём пищи не найден"}</p>
        ) : (
          <>
            {meal.hasPhoto && (
              <img
                src={photoUrl(meal)}
                alt="Фото еды"
                style={{ width: "100%", borderRadius: 12, maxHeight: 220, objectFit: "cover" }}
                className="mb"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
            )}
            <div className="card">
              <div className="row spread">
                <span className="hint small">🕐 Время приёма</span>
                <input
                  aria-label="Время приёма пищи"
                  type="time"
                  style={{ width: 120 }}
                  value={new Date(meal.eatenAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                  disabled={busy}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    if (h === undefined || m === undefined || Number.isNaN(h)) return;
                    const d = new Date(meal.eatenAt);
                    d.setHours(h, m, 0, 0);
                    void changeTime(d.toISOString());
                  }}
                />
              </div>
            </div>
            {meal.items.map((it) => (
              <div className="card" key={it.id}>
                <div className="row spread">
                  <b>{it.dish}</b>
                  <button className="btn danger" style={{ width: "auto", padding: "4px 8px" }} disabled={busy} onClick={() => void removeItem(it.id)}>
                    Удалить
                  </button>
                </div>
                {(() => {
                  // Живой пересчёт при перетаскивании слайдера — сервер догоняет на отпускании
                  const k = it.grams > 0 ? (grams[it.id] ?? it.grams) / it.grams : 0;
                  return (
                    <p className="hint small">
                      {r0(grams[it.id] ?? it.grams)} г · <b>{r0(it.kcal * k)} ккал</b> · Б {r0(it.protein * k)} / Ж {r0(it.fat * k)} / У {r0(it.carbs * k)}
                    </p>
                  );
                })()}
                <input
                  aria-label={`Порция: ${it.dish}, граммы`}
                  type="range"
                  min={10}
                  max={Math.max(600, it.grams * 2)}
                  step={5}
                  value={grams[it.id] ?? it.grams}
                  disabled={busy}
                  onChange={(e) => setGrams({ ...grams, [it.id]: Number(e.target.value) })}
                  onKeyUp={() => void commitGrams(it.id, grams[it.id] ?? it.grams)}
                  onMouseUp={() => void commitGrams(it.id, grams[it.id] ?? it.grams)}
                  onTouchEnd={() => void commitGrams(it.id, grams[it.id] ?? it.grams)}
                />
              </div>
            ))}
            <div className="card">
              <b>Итого: {r0(meal.totalKcal)} ккал</b>
              <p className="hint small">Б {r0(meal.totalProtein)} · Ж {r0(meal.totalFat)} · У {r0(meal.totalCarbs)}</p>
            </div>
            <div className="card">
              <p className="hint small mb">Добавить блюдо текстом</p>
              <div className="row">
                <input aria-label="Добавить блюдо текстом" type="text" value={addText} placeholder="ещё был компот…" onChange={(e) => setAddText(e.target.value)} />
                <button aria-label="Добавить блюдо" className="btn" style={{ width: "auto" }} disabled={busy || addText.trim().length < 3} onClick={() => void addItem()}>
                  +
                </button>
              </div>
            </div>
            {error && <p className="hint small mb" style={{ color: "#e53935" }}>{error}</p>}
            <button className="btn danger" disabled={busy} onClick={() => void removeMeal()}>
              🗑 Удалить весь приём
            </button>
          </>
        )}
      </div>
    </div>
  );
}
