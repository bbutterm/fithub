import { useEffect, useState } from "react";
import { ApiError, authorize } from "./api";
import { getRawInitData, getStartParam } from "./telegram";
import type { Profile } from "./types";
import { Onboarding } from "./screens/Onboarding";
import { Today } from "./screens/Today";
import { Recipes } from "./screens/Recipes";
import { Challenges } from "./screens/Challenges";
import { warm } from "./prefetch";
import { Analytics } from "./screens/Analytics";
import { Settings } from "./screens/Settings";
import { Subscription } from "./screens/Subscription";
import { Admin } from "./screens/Admin";

type Tab = "today" | "recipes" | "challenges" | "analytics" | "settings" | "subscription" | "admin";

function initialRoute(): { tab: Tab; mealId?: number } {
  const url = new URL(window.location.href);
  const start = getStartParam() ?? "";
  const mealParam = url.searchParams.get("meal") ?? (start.startsWith("meal_") ? start.slice(5) : null);
  if (mealParam && /^\d+$/.test(mealParam)) return { tab: "today", mealId: Number(mealParam) };
  const screen = url.searchParams.get("screen") ?? start;
  if (screen === "recipes") return { tab: "recipes" };
  if (screen === "challenges") return { tab: "challenges" };
  if (screen === "settings") return { tab: "settings" };
  if (screen === "subscription") return { tab: "subscription" };
  if (screen === "analytics") return { tab: "analytics" };
  return { tab: "today" };
}

export default function App() {
  const [state, setState] = useState<"loading" | "error" | "onboarding" | "ready">("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plan, setPlan] = useState<"free" | "pro">("free");
  const [isAdmin, setIsAdmin] = useState(false);
  const [userName, setUserName] = useState<string | null>(null);
  // Причина отказа во входе. Раньше экран говорил только «не удалось», и понять,
  // что именно сломалось — пустой initData, отказ сервера или сеть, — было
  // нельзя ни пользователю, ни по логам.
  const [errorDetail, setErrorDetail] = useState("");
  const [route] = useState(initialRoute);
  const [tab, setTab] = useState<Tab>(route.tab);

  useEffect(() => {
    (async () => {
      try {
        // Один запрос вместо двух: авторизация сразу возвращает профиль, план и права
        const auth = await authorize();
        setUserName(auth.user.firstName);
        if (!auth.hasProfile) {
          setState("onboarding");
          return;
        }
        setProfile(auth.profile);
        setPlan(auth.plan);
        setIsAdmin(auth.isAdmin);
        setState("ready");
        // Данные остальных вкладок — заранее и параллельно, пока человек смотрит первую
        warm();
      } catch (err) {
        const raw = getRawInitData();
        setErrorDetail(
          !raw
            ? "Telegram не передал данные входа. Так бывает, если открыть ссылку в обычном браузере."
            : err instanceof ApiError
              ? `Сервер ответил ${err.status} (${err.code}).`
              : `Не дозвонились до сервера: ${String(err).slice(0, 120)}`
        );
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
          <p className="hint mb">Откройте приложение из Telegram — кнопкой у бота.</p>
          {errorDetail && <p className="hint small">{errorDetail}</p>}
          <button className="chip mt" onClick={() => window.location.reload()}>
            Попробовать снова
          </button>
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
      {tab === "today" && <Today profile={profile} initialMealId={route.mealId} userName={userName} />}
      {tab === "recipes" && <Recipes />}
      {tab === "challenges" && <Challenges />}
      {tab === "analytics" && <Analytics plan={plan} onGoPro={() => setTab("subscription")} />}
      {tab === "settings" && profile && (
        <Settings profile={profile} onSaved={setProfile} onOpenSubscription={() => setTab("subscription")} isAdmin={isAdmin} onOpenAdmin={() => setTab("admin")} />
      )}
      {tab === "subscription" && <Subscription onBack={() => setTab("settings")} />}
      {tab === "admin" && isAdmin && <Admin />}

      <nav className="tabbar" aria-label="Основная навигация">
        {(
          [
            ["today", "🍽", "Сегодня"],
            ["recipes", "🍲", "Блюда"],
            ["challenges", "🎯", "Челлендж"],
            ["analytics", "📈", "Аналитика"],
            ["settings", "⚙️", "Профиль"]
          ] as Array<[Tab, string, string]>
        ).map(([id, icon, label]) => (
          // Админка открывается из настроек, поэтому пока она на экране — подсвечены настройки
          <button
            key={id}
            className={tab === id || ((tab === "admin" || tab === "subscription") && id === "settings") ? "active" : ""}
            aria-current={tab === id || ((tab === "admin" || tab === "subscription") && id === "settings") ? "page" : undefined}
            onClick={() => { setTab(id); window.scrollTo(0, 0); }}
          >
            <span className="icon">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}
