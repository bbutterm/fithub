import { useEffect, useState } from "react";
import { api } from "../api";
import type { Recipe } from "../types";
import { haptic } from "../telegram";

const PORTIONS: Array<{ label: string; value: number }> = [
  { label: "½", value: 0.5 },
  { label: "1", value: 1 },
  { label: "1½", value: 1.5 },
  { label: "2", value: 2 }
];

const r0 = (v: number) => Math.round(v);

export function Recipes() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  function reload() {
    api
      .recipes()
      .then((r) => setRecipes(r.recipes))
      .catch(() => setRecipes([]));
  }
  useEffect(reload, []);

  async function log(recipe: Recipe, multiplier: number) {
    setBusy(true);
    try {
      await api.logRecipe(recipe.id, multiplier);
      haptic("success");
      setToast(`Записал: ${recipe.name}${multiplier === 1 ? "" : ` × ${multiplier}`}`);
      setOpen(null);
      reload();
      setTimeout(() => setToast(""), 2500);
    } catch {
      haptic("error");
      setToast("Не получилось записать");
    } finally {
      setBusy(false);
    }
  }

  async function rename(recipe: Recipe) {
    const name = window.prompt("Название блюда", recipe.name)?.trim();
    if (!name || name === recipe.name) return;
    await api.renameRecipe(recipe.id, name).catch(() => undefined);
    reload();
  }

  async function remove(recipe: Recipe) {
    if (!window.confirm(`Удалить «${recipe.name}» из моих блюд?`)) return;
    await api.deleteRecipe(recipe.id).catch(() => undefined);
    haptic("light");
    reload();
  }

  if (recipes === null) {
    return (
      <div className="screen center">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="screen">
      <h1>Мои блюда</h1>
      {toast && <p className="hint small mb">{toast}</p>}

      {recipes.length === 0 ? (
        <div className="card">
          <p className="hint">
            Здесь появятся блюда, которые вы едите регулярно. Пришлите боту фото еды и нажмите под
            карточкой <b>💾 В мои блюда</b> — потом такое же запишется одним тапом, без фото и ожидания.
          </p>
        </div>
      ) : (
        recipes.map((r) => (
          <div className="card" key={r.id}>
            <div className="row spread">
              <b>{r.name}</b>
              <span className="hint small">
                {r0(r.kcal)} ккал · {r0(r.portionGrams)} г
              </span>
            </div>
            <p className="hint small">
              Б {r0(r.protein)} / Ж {r0(r.fat)} / У {r0(r.carbs)}
              {r.timesUsed > 0 ? ` · записано ${r.timesUsed} раз` : ""}
            </p>

            {open === r.id ? (
              <>
                <p className="hint small mb">Сколько съели?</p>
                <div className="row wrap mb">
                  {PORTIONS.map((p) => (
                    <button key={p.value} className="chip" disabled={busy} onClick={() => void log(r, p.value)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="row wrap">
                  <button className="chip" onClick={() => setOpen(null)}>
                    Отмена
                  </button>
                  <button className="chip" onClick={() => void rename(r)}>
                    Переименовать
                  </button>
                  <button className="chip" onClick={() => void remove(r)}>
                    Удалить
                  </button>
                </div>
              </>
            ) : (
              <button className="btn" onClick={() => setOpen(r.id)}>Записать в дневник</button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
