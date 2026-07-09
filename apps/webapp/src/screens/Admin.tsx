import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { haptic } from "../telegram";
import type { AdminOverview, AdminUsageRow, AdminUser } from "../types";

const rub = (usd: number, rate: number) => `${(usd * rate).toFixed(2)} ₽`;

const PURPOSE_LABEL: Record<string, string> = {
  photo: "📷 фото",
  text_meal: "💬 текст",
  correction: "✏️ уточнение",
  advice: "🥗 совет",
  monthly: "📈 отчёт",
  probe: "🩺 probe",
  other: "прочее"
};

export function Admin() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rate, setRate] = useState(90);
  const [query, setQuery] = useState("");
  const [busyUser, setBusyUser] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [usage, setUsage] = useState<AdminUsageRow[]>([]);
  const [broadcastText, setBroadcastText] = useState("");
  const [broadcastResult, setBroadcastResult] = useState("");
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
      haptic("success");
      load();
    } catch {
      haptic("error");
      setError("Действие не выполнено");
    } finally {
      setBusyUser(null);
    }
  }

  function askLimit(u: AdminUser) {
    const raw = window.prompt(`Дневной лимит распознаваний для ${u.firstName ?? u.tgUserId} (пусто — вернуть общий):`, String(u.dailyLimitOverride ?? ""));
    if (raw === null) return;
    const limit = raw.trim() === "" ? null : Number(raw.trim());
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) return;
    void act(u.id, () => api.admin.setLimit(u.id, limit));
  }

  function toggleUsage(userId: number) {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    setUsage([]);
    api.admin.userUsage(userId).then((r) => setUsage(r.usage)).catch(() => undefined);
  }

  async function sendBroadcast() {
    const text = broadcastText.trim();
    if (text.length < 3) return;
    if (!window.confirm(`Отправить сообщение ВСЕМ пользователям (${overview?.usersCount ?? "?"})?\n\n«${text}»`)) return;
    setBroadcastResult("Отправляю…");
    try {
      const r = await api.admin.broadcast(text);
      setBroadcastResult(`Доставлено: ${r.sent}, не дошло: ${r.failed}`);
      setBroadcastText("");
      haptic("success");
    } catch {
      setBroadcastResult("Не получилось отправить");
      haptic("error");
    }
  }

  const filtered = users.filter((u) => {
    const q = query.toLowerCase();
    return !q || u.username?.toLowerCase().includes(q) || u.firstName?.toLowerCase().includes(q) || u.tgUserId.includes(q);
  });

  const maxDaySpend = Math.max(...(overview?.spendByDay.map((d) => d.costUsd) ?? [0]), 0.0001);

  return (
    <div className="screen">
      <div className="row spread">
        <h1>Админка</h1>
        <button className="chip" onClick={() => { haptic(); load(); }}>⟳ Обновить</button>
      </div>
      {error && <p className="hint mb" style={{ color: "var(--over)" }}>{error}</p>}

      {overview && (
        <>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="row spread">
              <span className="hint small">Сегодня</span>
              <b className="small">
                +{overview.usersToday} 👤 · {overview.mealsToday} 🍽 · {rub(overview.spend.todayUsd, overview.usdRubRate)}
              </b>
            </div>
          </div>

          <div className="stat-grid">
            <div className="card stat"><b>{overview.usersCount}</b><span className="hint small">пользователей</span></div>
            <div className="card stat"><b>{overview.activePro}</b><span className="hint small">Pro активно</span></div>
            <div className="card stat"><b>{rub(overview.spend.last30dUsd, overview.usdRubRate)}</b><span className="hint small">ИИ за 30 дней</span></div>
            <div className="card stat"><b>{rub(overview.spend.totalUsd, overview.usdRubRate)}</b><span className="hint small">ИИ всего</span></div>
          </div>

          {overview.spendByDay.length > 1 && (
            <div className="card">
              <h2>Расходы по дням, ₽</h2>
              <div className="chart" style={{ height: 90 }}>
                {overview.spendByDay.map((d) => (
                  <div className="bar-col" key={d.date} title={`${d.date}: ${rub(d.costUsd, overview.usdRubRate)}`}>
                    <div className="bar" style={{ height: `${Math.round((d.costUsd / maxDaySpend) * 100)}%` }} />
                    <div className="bar-date">{d.date.slice(8)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <h2>Расход по моделям</h2>
            {overview.byModel.length === 0 ? (
              <p className="hint small">Пока нет вызовов ИИ.</p>
            ) : (
              overview.byModel.map((m) => (
                <div className="row spread mt" key={`${m.client}:${m.model}`}>
                  <span className="small ellipsis" style={{ flex: 1.6 }}>
                    {m.client === "vision" ? "📷" : "💬"} {m.model}
                  </span>
                  <span className="hint small" style={{ flex: 1, textAlign: "center" }}>
                    {m.calls} выз · {Math.round((m.promptTokens + m.completionTokens) / 1000)}k ток
                  </span>
                  <b className="small">{rub(m.costUsd, overview.usdRubRate)}</b>
                </div>
              ))
            )}
            <p className="hint small mt">Курс: {overview.usdRubRate} ₽/$ (env USD_RUB_RATE)</p>
          </div>

          <div className="card">
            <h2>📣 Рассылка тестерам</h2>
            <textarea
              className="broadcast-input"
              rows={3}
              placeholder="Обновление! Теперь можно уточнять распознавание ответом на карточку…"
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
            />
            <button className="btn mt" disabled={broadcastText.trim().length < 3} onClick={() => void sendBroadcast()}>
              Отправить всем
            </button>
            {broadcastResult && <p className="hint small mt">{broadcastResult}</p>}
          </div>
        </>
      )}

      <div className="card">
        <h2>Пользователи</h2>
        <input type="text" placeholder="Поиск: имя, username, tg id…" value={query} onChange={(e) => setQuery(e.target.value)} className="mb" />
        {filtered.map((u) => (
          <div className="admin-user" key={u.id}>
            <div className="row spread">
              <div style={{ minWidth: 0 }}>
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
            <div className="row mt wrap">
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
              <button className="chip" onClick={() => toggleUsage(u.id)}>{expanded === u.id ? "Скрыть" : "📊 Вызовы"}</button>
            </div>
            {expanded === u.id && (
              <div className="usage-list mt">
                {usage.length === 0 ? (
                  <p className="hint small">Загружаю… (или вызовов ещё не было)</p>
                ) : (
                  usage.slice(0, 15).map((r, i) => (
                    <div className="row spread usage-row" key={i}>
                      <span className="hint small">{new Date(r.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="small" style={{ flex: 1, textAlign: "center" }}>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</span>
                      <span className="hint small">{r.promptTokens + r.completionTokens} ток</span>
                      <b className="small">{rub(r.costUsd, rate)}</b>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && <p className="hint small">Никого не нашлось.</p>}
      </div>
    </div>
  );
}
