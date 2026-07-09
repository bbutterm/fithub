import { useEffect, useState } from "react";
import { api, authorize } from "./api";
import { getStartParam } from "./telegram";
import type { Profile } from "./types";
import { Onboarding } from "./screens/Onboarding";
import { Today } from "./screens/Today";
import { Analytics } from "./screens/Analytics";
import { Settings } from "./screens/Settings";
import { Subscription } from "./screens/Subscription";

type Tab = "today" | "analytics" | "settings" | "subscription";

function initialRoute(): { tab: Tab; mealId?: number } {
  const url = new URL(window.location.href);
  const start = getStartParam() ?? "";
  const mealParam = url.searchParams.get("meal") ?? (start.startsWith("meal_") ? start.slice(5) : null);
  if (mealParam && /^\d+$/.test(mealParam)) return { tab: "today", mealId: Number(mealParam) };
  const screen = url.searchParams.get("screen") ?? start;
  if (screen === "settings") return { tab: "settings" };
  if (screen === "subscription") return { tab: "subscription" };
  if (screen === "analytics") return { tab: "analytics" };
  return { tab: "today" };
}

export default function App() {
  const [state, setState] = useState<"loading" | "error" | "onboarding" | "ready">("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plan, setPlan] = useState<"free" | "pro">("free");
  const [route] = useState(initialRoute);
  const [tab, setTab] = useState<Tab>(route.tab);

  useEffect(() => {
    (async () => {
      try {
        const auth = await authorize();
        if (!auth.hasProfile) {
          setState("onboarding");
          return;
        }
        const me = await api.me();
        setProfile(me.profile);
        setPlan(me.plan);
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  if (state === "loading") {
    return (
      <div className="screen center">
        <div className="spinner" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="screen center">
        <div className="card" style={{ marginTop: 60 }}>
          <h2>Не удалось авторизоваться</h2>
          <p className="hint">Откройте приложение из Telegram — кнопкой у бота.</p>
        </div>
      </div>
    );
  }

  if (state === "onboarding") {
    return (
      <Onboarding
        onDone={(p) => {
          setProfile(p);
          setState("ready");
        }}
      />
    );
  }

  return (
    <>
      {tab === "today" && <Today profile={profile} initialMealId={route.mealId} />}
      {tab === "analytics" && <Analytics plan={plan} onGoPro={() => setTab("subscription")} />}
      {tab === "settings" && profile && <Settings profile={profile} onSaved={setProfile} />}
      {tab === "subscription" && <Subscription />}

      <nav className="tabbar">
        {(
          [
            ["today", "🍽", "Сегодня"],
            ["analytics", "📈", "Аналитика"],
            ["settings", "⚙️", "Настройки"],
            ["subscription", "⭐", "Pro"]
          ] as Array<[Tab, string, string]>
        ).map(([id, icon, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            <span className="icon">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}
