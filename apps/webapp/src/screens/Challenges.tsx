import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChallengesResponse, Feasibility } from "../types";
import { haptic } from "../telegram";

// Пропуск и заморозка выглядят иначе, чем провал: человек должен видеть,
// что прогресс цел, а не читать ряд одинаковых крестиков.
const DAY_ICON: Record<string, string> = { pass: "✅", fail: "❌", frozen: "🧊", skip: "➖" };
const DAY_TITLE: Record<string, string> = {
  pass: "засчитан",
  fail: "не засчитан",
  frozen: "заморожен",
  skip: "записей не было"
};

export function Challenges() {
  const [data, setData] = useState<ChallengesResponse | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [check, setCheck] = useState<Feasibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function reload() {
    api
      .challenges()
      .then(setData)
      .catch(() => setError("Не удалось загрузить"));
  }
  useEffect(reload, []);

  async function pick(templateId: string) {
    setPicked(templateId);
    setCheck(null);
    try {
      setCheck(await api.challengeFeasibility(templateId));
    } catch {
      setCheck(null);
    }
  }

  async function start(templateId: string, value?: number) {
    setBusy(true);
    setError("");
    try {
      await api.startChallenge(templateId, value);
      haptic("success");
      setPicked(null);
      setCheck(null);
      reload();
    } catch {
      haptic("error");
      setError("Не получилось начать. Возможно, челлендж уже идёт.");
    } finally {
      setBusy(false);
    }
  }

  async function quit(id: number) {
    if (!window.confirm("Бросить челлендж? Прогресс останется в истории.")) return;
    await api.quitChallenge(id).catch(() => undefined);
    haptic("light");
    reload();
  }

  if (!data) {
    return (
      <div className="screen center">
        {error ? <p className="hint">{error}</p> : <div className="spinner" />}
      </div>
    );
  }

  const a = data.active;

  return (
    <div className="screen">
      <h1>Челленджи</h1>
      {error && <p className="hint small mb">{error}</p>}

      {a ? (
        <>
          <div className="card">
            <div className="row spread">
              <b>{a.title}</b>
              <span className="hint small">
                {a.dayNo < 1 ? `старт ${a.startDate}` : `день ${Math.min(a.dayNo, a.totalDays)} из ${a.totalDays}`}
              </span>
            </div>
            <p className="hint small">{a.ruleText}</p>

            <p className="small mb">
              Засчитано: <b>{a.progress.passed}</b> · заморозок осталось: {a.jokersLeft}
            </p>

            {/* Календарь: каждый день челленджа — отдельная клетка */}
            <div className="row wrap mb" style={{ gap: 6 }}>
              {Array.from({ length: a.totalDays }, (_, i) => {
                const day = a.days[i];
                const label = day ? DAY_ICON[day.status] : "·";
                const title = day ? `${day.date}: ${DAY_TITLE[day.status]}${day.fact ? ` (${day.fact})` : ""}` : "ещё впереди";
                return (
                  <span
                    key={i}
                    title={title}
                    style={{
                      width: 30,
                      height: 30,
                      lineHeight: "30px",
                      textAlign: "center",
                      borderRadius: 8,
                      background: "var(--tg-secondary-bg)",
                      fontSize: 14
                    }}
                  >
                    {label}
                  </span>
                );
              })}
            </div>

            <p className="hint small">
              Итог дня приходит вечером в чат. Отмечать ничего не нужно — я смотрю по вашим записям.
            </p>
          </div>

          {a.participants.length > 1 && (
            <div className="card">
              <h2>Участники</h2>
              {/* Только засчитанные дни: калории и вес не показываем никому, иначе
                  вступать в совместные челленджи перестанут */}
              {a.participants.map((p) => (
                <div className="row spread" key={p.userId}>
                  <span>
                    {p.firstName ?? "Участник"}
                    {p.isMe ? " (вы)" : ""}
                  </span>
                  <span className="hint small">
                    {p.passed} дн.{p.frozen ? ` · 🧊 ${p.frozen}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <p className="hint small mb">Позвать друга — отправьте ему ссылку:</p>
            <code className="small">{a.inviteUrl || `код: ${a.joinCode}`}</code>
            <div className="row wrap" style={{ marginTop: 12 }}>
              <button className="btn secondary" onClick={() => void quit(a.id)}>
                Бросить челлендж
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="card">
            <p className="hint">
              Выберите челлендж — я буду проверять его сам по вашим записям о еде и присылать итог каждый
              вечер. Отмечать ничего не нужно. Одновременно идёт один: три сразу — это ноль выполненных.
            </p>
          </div>

          {data.templates.map((t) => (
            <div className="card" key={t.id}>
              <div className="row spread">
                <b>{t.title}</b>
                <span className="hint small">{t.days} дней</span>
              </div>
              <p className="hint small">{t.ruleText}</p>

              {picked === t.id ? (
                <>
                  {check === null ? (
                    <p className="hint small mb">Смотрю вашу историю…</p>
                  ) : (
                    check.reason && <p className="small mb">{check.reason}</p>
                  )}
                  <div className="row wrap">
                    {check?.verdict !== "refuse" && (
                      <>
                        {check?.verdict === "risky" && check.suggestedValue !== undefined && (
                          <button className="chip" disabled={busy} onClick={() => void start(t.id, check.suggestedValue)}>
                            Взять {check.suggestedValue}
                          </button>
                        )}
                        <button
                          className={check?.verdict === "risky" ? "chip" : "btn"}
                          disabled={busy}
                          onClick={() => void start(t.id)}
                        >
                          {check?.verdict === "risky" ? "Всё равно как есть" : "Начать"}
                        </button>
                      </>
                    )}
                    <button className="chip" onClick={() => setPicked(null)}>
                      Отмена
                    </button>
                  </div>
                </>
              ) : (
                <button className="btn" onClick={() => void pick(t.id)}>Выбрать</button>
              )}
            </div>
          ))}
        </>
      )}

      {data.finished.length > 0 && (
        <div className="card">
          <h2>История</h2>
          {data.finished.map((f) => (
            <div className="row spread" key={f.id}>
              <span>{f.title}</span>
              <span className="hint small">{f.status === "done" ? `${f.totalDays} дней · пройден` : "брошен"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
