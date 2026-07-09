import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AdminOverview, AdminUser } from "../types";

const rub = (usd: number, rate: number) => `${(usd * rate).toFixed(2)} ₽`;

export function Admin() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rate, setRate] = useState(90);
  const [query, setQuery] = useState("");
  const [busyUser, setBusyUser] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.admin.overview().then(setOverview).catch(() => setError("Нет доступа к админке"));
    api.admin
      .users()
      .then((r) => {
        setUsers(r.users);
        setRate(r.usdRubRate);
      })
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function act(userId: number, fn: () => Promise<unknown>) {
    setBusyUser(userId);
    setError("");
    try {
      await fn();
      load();
    } catch {
      setError("Действие не выполнено");
    } finally {
      setBusyUser(null);
    }
  }

  function askLimit(u: AdminUser) {
    const raw = window.prompt(`Дневной лимит распознаваний для ${u.firstName ?? u.tgUserId} (пусто — вернуть общий ${""}лимит):`, String(u.dailyLimitOverride ?? ""));
    if (raw === null) return;
    const limit = raw.trim() === "" ? null : Number(raw.trim());
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) return;
    void act(u.id, () => api.admin.setLimit(u.id, limit));
  }

  const filtered = users.filter((u) => {
    const q = query.toLowerCase();
    return !q || u.username?.toLowerCase().includes(q) || u.firstName?.toLowerCase().includes(q) || u.tgUserId.includes(q);
  });

  return (
    <div className="screen">
      <h1>Админка</h1>
      {error && <p className="hint mb" style={{ color: "#e53935" }}>{error}</p>}

      {overview && (
        <>
          <div className="stat-grid">
            <div className="card stat"><b>{overview.usersCount}</b><span className="hint small">пользователей</span></div>
            <div className="card stat"><b>{overview.activePro}</b><span className="hint small">Pro активно</span></div>
            <div className="card stat"><b>{rub(overview.spend.last30dUsd, overview.usdRubRate)}</b><span className="hint small">ИИ за 30 дней</span></div>
            <div className="card stat"><b>{rub(overview.spend.totalUsd, overview.usdRubRate)}</b><span className="hint small">ИИ всего</span></div>
          </div>

          <div className="card">
            <h2>Расход по моделям</h2>
            {overview.byModel.length === 0 ? (
              <p className="hint small">Пока нет вызовов ИИ.</p>
            ) : (
              overview.byModel.map((m) => (
                <div className="row spread mt" key={`${m.client}:${m.model}`}>
                  <span className="small" style={{ flex: 1.6, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {m.client === "vision" ? "📷" : "💬"} {m.model}
                  </span>
                  <span className="hint small" style={{ flex: 1, textAlign: "center" }}>
                    {m.calls} выз · {Math.round((m.promptTokens + m.completionTokens) / 1000)}k ток
                  </span>
                  <b className="small">{rub(m.costUsd, overview.usdRubRate)}</b>
                </div>
              ))
            )}
            <p className="hint small mt">Курс для пересчёта: {overview.usdRubRate} ₽/$ (переменная USD_RUB_RATE).</p>
          </div>
        </>
      )}

      <div className="card">
        <h2>Пользователи</h2>
        <input type="text" placeholder="Поиск: имя, username, tg id…" value={query} onChange={(e) => setQuery(e.target.value)} className="mb" />
        {filtered.map((u) => (
          <div className="admin-user" key={u.id}>
            <div className="row spread">
              <div>
                <b>{u.firstName ?? "—"}</b> {u.username && <span className="hint">@{u.username}</span>} {u.isAdmin && "🛡"}
                <div className="hint small">
                  id {u.tgUserId} · блюд {u.mealsCount} · ИИ {u.aiCalls} выз · <b>{rub(u.costUsd, rate)}</b>
                </div>
              </div>
              <span className={`badge ${u.plan === "pro" ? "badge-pro" : ""}`}>
                {u.plan === "pro" ? `PRO до ${u.proExpiresAt ? new Date(u.proExpiresAt).toLocaleDateString("ru-RU") : ""}` : "free"}
                {u.dailyLimitOverride !== null && ` · лимит ${u.dailyLimitOverride}`}
              </span>
            </div>
            <div className="row mt">
              <button className="chip" disabled={busyUser === u.id} onClick={() => void act(u.id, () => api.admin.grantPro(u.id, 30))}>
                +30д Pro
              </button>
              <button className="chip" disabled={busyUser === u.id} onClick={() => void act(u.id, () => api.admin.grantPro(u.id, 365))}>
                +год
              </button>
              {u.plan === "pro" && (
                <button className="chip" disabled={busyUser === u.id} onClick={() => void act(u.id, () => api.admin.revokePro(u.id))}>
                  Снять Pro
                </button>
              )}
              <button className="chip" disabled={busyUser === u.id} onClick={() => askLimit(u)}>
                Лимит…
              </button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && <p className="hint small">Никого не нашлось.</p>}
      </div>
    </div>
  );
}
