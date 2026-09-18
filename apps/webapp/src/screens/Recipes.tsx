import { useEffect, useState } from "react";
import { api } from "../api";
import type { Recipe } from "../types";
import { haptic } from "../telegram";
import { load, peek } from "../prefetch";

const PORTIONS: Array<{ label: string; value: number }> = [
  { label: "½", value: 0.5 },
  { label: "1", value: 1 },
  { label: "1½", value: 1.5 },
  { label: "2", value: 2 }
];

const r0 = (v: number) => Math.round(v);

export function Recipes() {
  // Стартуем с предзагруженных данных: вкладка открывается без спиннера
  const [recipes, setRecipes] = useState<Recipe[] | null>(peek<{ recipes: Recipe[] }>("recipes")?.recipes ?? null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Recipe | null>(null);

  function reload(fresh = true) {
    setError("");
    load<{ recipes: Recipe[] }>("recipes", fresh)
      .then((r) => setRecipes(r.recipes))
      .catch(() => setError("Не удалось загрузить блюда. Повтори попытку."));
  }
  // Первый показ — из кэша, если он есть; иначе обычная загрузка
  useEffect(() => reload(!peek("recipes")), []);

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
    if (!name.trim()) return;
    setBusy(true);
    try { await api.renameRecipe(recipe.id, name.trim()); setEditing(null); reload(); }
    catch { setToast("Не удалось сохранить название. Попробуй ещё раз."); }
    finally { setBusy(false); }
  }
  async function remove(recipe: Recipe) {
    setBusy(true);
    try { await api.deleteRecipe(recipe.id); setDeleting(null); haptic("light"); reload(); }
    catch { setToast("Не удалось удалить блюдо. Попробуй ещё раз."); }
    finally { setBusy(false); }
  }

  if (recipes === null) {
    return (
      <div className="screen center">
        {error ? <><p role="alert">{error}</p><button className="chip mt" onClick={() => reload()}>Повторить</button></> : <div className="spinner" />}
      </div>
    );
  }

  return (
    <div className="screen">
      <h1>Мои блюда</h1>
      <p className="hint screen-intro">Любимые блюда — в дневник без повторного распознавания</p>
      {error && <div className="card" role="alert"><p>{error}</p><button className="chip mt" onClick={() => reload()}>Повторить</button></div>}
      {toast && <p role="status" className="card">{toast}</p>}
      {editing && <form className="card" onSubmit={e => { e.preventDefault(); void rename(editing); }}>
        <label className="field"><span>Название блюда</span><input type="text" autoFocus maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="row"><button className="btn" disabled={busy || !name.trim()}>Сохранить</button><button type="button" className="chip" disabled={busy} onClick={() => setEditing(null)}>Отмена</button></div>
      </form>}
      {deleting && <section className="card" aria-label="Подтверждение удаления"><h2>Удалить «{deleting.name}»?</h2><p className="hint mb">Блюдо исчезнет из сохранённых. Записи в дневнике останутся.</p><div className="row"><button className="chip" disabled={busy} onClick={() => setDeleting(null)}>Отмена</button><button className="btn danger" disabled={busy} onClick={() => void remove(deleting)}>Удалить</button></div></section>}


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
              {/* nowrap: у длинного названия «г» уезжало на вторую строку */}
              <span className="hint small" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                {r0(r.kcal)} ккал · {r0(r.portionGrams)} г
              </span>
            </div>
            <p className="hint small mb">
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
                  <button className="chip" onClick={() => { setEditing(r); setName(r.name); setDeleting(null); window.scrollTo(0, 0); }}>
                    Переименовать
                  </button>
                  <button className="chip" onClick={() => { setDeleting(r); setEditing(null); window.scrollTo(0, 0); }}>
                    Удалить
                  </button>
                </div>
              </>
            ) : (
              <button className="chip" onClick={() => setOpen(r.id)}>Записать в дневник</button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
