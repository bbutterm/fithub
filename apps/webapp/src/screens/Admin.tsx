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

type AdminTab = "overview" | "users" | "broadcast";

export function Admin() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rate, setRate] = useState(90);
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

  return (
    <div className="screen">
      <div className="row spread">
        <h1>Админка</h1>
        <button className="chip" onClick={() => { haptic(); load(); }}>⟳</button>
      </div>
      {error && <p className="hint mb" style={{ color: "var(--over)" }}>{error}</p>}

      <div className="row mb mt">
        <button className={`chip ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}>Обзор</button>
        <button className={`chip ${tab === "users" ? "active" : ""}`} onClick={() => setTab("users")}>
          Юзеры{users.length ? ` · ${users.length}` : ""}
        </button>
        <button className={`chip ${tab === "broadcast" ? "active" : ""}`} onClick={() => setTab("broadcast")}>📣 Рассылка</button>
      </div>

      {tab === "overview" && <OverviewTab overview={overview} />}
      {tab === "users" && <UsersTab users={users} rate={rate} onChanged={load} />}
      {tab === "broadcast" && <BroadcastTab usersCount={overview?.usersCount ?? users.length} />}
    </div>
  );
}

function OverviewTab({ overview }: { overview: AdminOverview | null }) {
  if (!overview) return <div className="spinner" />;
  const r = overview.usdRubRate;
  const maxDaySpend = Math.max(...overview.spendByDay.map((d) => d.costUsd), 0.0001);
  return (
    <>
      <div className="card">
        <div className="row spread">
          <span className="hint small">Сегодня</span>
          <b className="small">+{overview.usersToday} 👤 · {overview.mealsToday} 🍽 · {rub(overview.spend.todayUsd, r)}</b>
        </div>
      </div>
      <div className="stat-grid">
        <div className="card stat"><b>{overview.usersCount}</b><span className="hint small">пользователей</span></div>
        <div className="card stat"><b>{overview.activePro}</b><span className="hint small">Pro активно</span></div>
        <div className="card stat"><b>{rub(overview.spend.last30dUsd, r)}</b><span className="hint small">ИИ за 30 дней</span></div>
        <div className="card stat"><b>{rub(overview.spend.totalUsd, r)}</b><span className="hint small">ИИ всего</span></div>
      </div>
      {overview.spendByDay.length > 1 && (
        <div className="card">
          <h2>Расходы по дням, ₽</h2>
          <div className="chart" style={{ height: 90 }}>
            {overview.spendByDay.map((d) => (
              <div className="bar-col" key={d.date} title={`${d.date}: ${rub(d.costUsd, r)}`}>
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
              <span className="small ellipsis" style={{ flex: 1.6 }}>{m.client === "vision" ? "📷" : "💬"} {m.model}</span>
              <span className="hint small" style={{ flex: 1, textAlign: "center" }}>
                {m.calls} выз · {Math.round((m.promptTokens + m.completionTokens) / 1000)}k
              </span>
              <b className="small">{rub(m.costUsd, r)}</b>
            </div>
          ))
        )}
        <p className="hint small mt">Курс: {r} ₽/$ (env USD_RUB_RATE)</p>
      </div>
    </>
  );
}

function UsersTab({ users, rate, onChanged }: { users: AdminUser[]; rate: number; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"new" | "spend" | "meals">("new");
  const [openId, setOpenId] = useState<number | null>(null);

  const filtered = users
    .filter((u) => {
      const q = query.toLowerCase();
      return !q || u.username?.toLowerCase().includes(q) || u.firstName?.toLowerCase().includes(q) || u.tgUserId.includes(q);
    })
    .sort((a, b) =>
      sort === "spend" ? b.costUsd - a.costUsd : sort === "meals" ? b.mealsCount - a.mealsCount : b.id - a.id
    );

  return (
    <div className="card">
      <input type="text" placeholder="Поиск: имя, username, tg id…" value={query} onChange={(e) => setQuery(e.target.value)} className="mb" />
      <div className="row mb">
        <button className={`chip ${sort === "new" ? "active" : ""}`} onClick={() => setSort("new")}>Новые</button>
        <button className={`chip ${sort === "spend" ? "active" : ""}`} onClick={() => setSort("spend")}>По тратам</button>
        <button className={`chip ${sort === "meals" ? "active" : ""}`} onClick={() => setSort("meals")}>По активности</button>
      </div>
      {filtered.map((u) => (
        <UserRow key={u.id} u={u} rate={rate} open={openId === u.id} onToggle={() => setOpenId(openId === u.id ? null : u.id)} onChanged={onChanged} />
      ))}
      {filtered.length === 0 && <p className="hint small">Никого не нашлось.</p>}
    </div>
  );
}

function UserRow({ u, rate, open, onToggle, onChanged }: { u: AdminUser; rate: number; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [limitValue, setLimitValue] = useState(u.dailyLimitOverride?.toString() ?? "");
  const [usage, setUsage] = useState<AdminUsageRow[] | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open && usage === null) {
      api.admin.userUsage(u.id).then((r) => setUsage(r.usage)).catch(() => setUsage([]));
    }
  }, [open, usage, u.id]);

  async function act(fn: () => Promise<unknown>, okNote: string) {
    setBusy(true);
    setNote("");
    try {
      await fn();
      haptic("success");
      setNote(okNote);
      onChanged();
    } catch {
      haptic("error");
      setNote("Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  }

  function saveLimit() {
    const raw = limitValue.trim();
    const limit = raw === "" ? null : Number(raw);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) return;
    void act(() => api.admin.setLimit(u.id, limit), limit === null ? "Лимит сброшен на общий" : `Лимит: ${limit}/день`);
  }

  return (
    <div className={`admin-user ${open ? "open" : ""}`}>
      <div className="row spread admin-user-head" onClick={onToggle}>
        <div style={{ minWidth: 0 }}>
          <b>{u.firstName ?? "—"}</b> {u.username && <span className="hint">@{u.username}</span>} {u.isAdmin && "🛡"}
          <div className="hint small">🍽 {u.mealsCount} · ИИ {u.aiCalls} · <b>{rub(u.costUsd, rate)}</b></div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className={`badge ${u.plan === "pro" ? "badge-pro" : ""}`}>
            {u.plan === "pro" ? "PRO" : "free"}
            {u.dailyLimitOverride !== null && ` · ${u.dailyLimitOverride}/д`}
          </span>
          <span className="hint">{open ? "▴" : "▾"}</span>
        </div>
      </div>

      {open && (
        <div className="admin-user-body">
          <p className="hint small mb">
            tg id {u.tgUserId} · с {new Date(u.createdAt).toLocaleDateString("ru-RU")}
            {u.plan === "pro" && u.proExpiresAt && <> · Pro до {new Date(u.proExpiresAt).toLocaleDateString("ru-RU")}</>}
          </p>

          <p className="hint small" style={{ marginBottom: 4 }}>Подписка</p>
          <div className="row wrap mb">
            <button className="chip" disabled={busy} onClick={() => void act(() => api.admin.grantPro(u.id, 30), "Pro +30 дней ✓")}>+30 дней</button>
            <button className="chip" disabled={busy} onClick={() => void act(() => api.admin.grantPro(u.id, 365), "Pro +год ✓")}>+год</button>
            {u.plan === "pro" && (
              <button className="chip" disabled={busy} onClick={() => void act(() => api.admin.revokePro(u.id), "Pro снят")}>Снять Pro</button>
            )}
          </div>

          <p className="hint small" style={{ marginBottom: 4 }}>Дневной лимит распознаваний (пусто = общий)</p>
          <div className="row mb">
            <input type="number" inputMode="numeric" placeholder="напр. 10" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} style={{ maxWidth: 120 }} />
            <button className="chip" disabled={busy} onClick={saveLimit}>Сохранить</button>
            {u.dailyLimitOverride !== null && (
              <button className="chip" disabled={busy} onClick={() => { setLimitValue(""); void act(() => api.admin.setLimit(u.id, null), "Лимит сброшен"); }}>Сбросить</button>
            )}
          </div>

          {note && <p className="small mb" style={{ color: "var(--brand)" }}>{note}</p>}

          <p className="hint small" style={{ marginBottom: 4 }}>Последние вызовы ИИ</p>
          <div className="usage-list">
            {usage === null ? (
              <p className="hint small">Загружаю…</p>
            ) : usage.length === 0 ? (
              <p className="hint small">Вызовов ещё не было.</p>
            ) : (
              usage.slice(0, 10).map((r, i) => (
                <div className="row spread usage-row" key={i}>
                  <span className="hint small">{new Date(r.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="small" style={{ flex: 1, textAlign: "center" }}>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</span>
                  <b className="small">{rub(r.costUsd, rate)}</b>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BroadcastTab({ usersCount }: { usersCount: number }) {
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState("");

  async function send() {
    setSending(true);
    setResult("");
    try {
      const r = await api.admin.broadcast(text.trim());
      setResult(`✅ Доставлено: ${r.sent}${r.failed ? `, не дошло: ${r.failed} (заблокировали бота)` : ""}`);
      setText("");
      haptic("success");
    } catch {
      setResult("Не получилось отправить, попробуйте ещё раз");
      haptic("error");
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  return (
    <div className="card">
      <h2>Сообщение всем пользователям</h2>
      <p className="hint small mb">Анонс обновления, просьба потестить фичу — уйдёт в чат бота каждому ({usersCount} чел).</p>
      <textarea
        className="broadcast-input"
        rows={4}
        placeholder={"Обновление! Теперь можно уточнять распознавание — просто ответь на карточку еды.\n\nПопробуйте и напишите, как вам 🙌"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setConfirming(false);
        }}
      />
      {!confirming ? (
        <button className="btn mt" disabled={text.trim().length < 3 || sending} onClick={() => setConfirming(true)}>
          Отправить всем ({usersCount})
        </button>
      ) : (
        <div className="row mt">
          <button className="btn secondary" disabled={sending} onClick={() => setConfirming(false)}>Отмена</button>
          <button className="btn" disabled={sending} onClick={() => void send()}>
            {sending ? "Отправляю…" : "Да, отправить"}
          </button>
        </div>
      )}
      {result && <p className="small mt">{result}</p>}
    </div>
  );
}
