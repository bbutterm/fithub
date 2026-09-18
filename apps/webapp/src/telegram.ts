import { init, retrieveRawInitData } from "@telegram-apps/sdk-react";

// Минимальная типизация нативного WebApp API (скрипт telegram-web-app.js подключён в index.html)
interface TelegramWebApp {
  initData?: string;
  themeParams?: Record<string, string>;
  colorScheme?: "light" | "dark";
  start_param?: string;
  initDataUnsafe?: { start_param?: string };
  expand?: () => void;
  ready?: () => void;
  close?: () => void;
  openInvoice?: (url: string, cb?: (status: string) => void) => void;
  HapticFeedback?: {
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function webApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

let sdkInited = false;
export function initTelegram(): void {
  try {
    if (!sdkInited) {
      init();
      sdkInited = true;
    }
  } catch {
    // вне Telegram (обычный браузер) — работаем через fallback
  }
  try {
    webApp()?.ready?.();
    webApp()?.expand?.();
  } catch {
    /* noop */
  }
}

export function getRawInitData(): string {
  try {
    const raw = retrieveRawInitData();
    if (raw) return raw;
  } catch {
    /* fallback ниже */
  }
  return webApp()?.initData ?? "";
}

export function getStartParam(): string | undefined {
  return webApp()?.initDataUnsafe?.start_param ?? webApp()?.start_param;
}

/** Закрываем Mini App и возвращаем человека в чат, чтобы добавить фото или текстом описать еду. */
export function closeToBot(): void {
  try {
    const wa = webApp();
    if (wa?.close) {
      wa.close();
    }
  } catch {
    /* noop */
  }
}

export function openInvoice(url: string, onPaid: () => void): void {
  const wa = webApp();
  if (wa?.openInvoice) {
    wa.openInvoice(url, (status) => {
      if (status === "paid") {
        wa.HapticFeedback?.notificationOccurred?.("success");
        onPaid();
      }
    });
  } else {
    window.open(url, "_blank");
  }
}

/** Тактильный отклик на действия (безопасно вне Telegram — просто no-op). */
export function haptic(type: "light" | "success" | "error" | "warning" = "light"): void {
  try {
    const h = webApp()?.HapticFeedback;
    if (type === "light") h?.impactOccurred?.("light");
    else h?.notificationOccurred?.(type);
  } catch {
    /* noop */
  }
}

/** Применяем тему Telegram к CSS-переменным. */
export function applyTheme(): void {
  const wa = webApp();
  const tp = wa?.themeParams ?? {};
  const root = document.documentElement;
  const dark = wa?.colorScheme === "dark" || (!wa?.colorScheme && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  const map: Record<string, string> = {
    "--tg-bg": tp.bg_color ?? (dark ? "#18222d" : "#ffffff"),
    "--tg-secondary-bg": tp.secondary_bg_color ?? (dark ? "#131c26" : "#f1f4f8"),
    "--tg-text": tp.text_color ?? (dark ? "#f5f5f5" : "#1a1a1a"),
    "--tg-hint": tp.hint_color ?? (dark ? "#8a99a8" : "#8e8e93"),
    "--tg-link": tp.link_color ?? "#2481cc",
    "--tg-button": tp.button_color ?? "#2481cc",
    "--tg-button-text": tp.button_text_color ?? "#ffffff",
    "--tg-card": tp.section_bg_color ?? (dark ? "#212f3d" : "#ffffff")
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
}
