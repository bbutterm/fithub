#!/usr/bin/env node
// Регистрирует Telegram-webhook на WEBAPP_URL/api/tg-webhook с secret_token.
// Запуск: BOT_TOKEN=... WEBAPP_URL=https://<проект>.vercel.app node scripts/set-webhook.mjs
import { createHash } from "node:crypto";

const { BOT_TOKEN, WEBAPP_URL } = process.env;
if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error("Задайте BOT_TOKEN и WEBAPP_URL: BOT_TOKEN=... WEBAPP_URL=https://... node scripts/set-webhook.mjs");
  process.exit(1);
}

const secret = createHash("sha256").update(`${BOT_TOKEN}:webhook`).digest("hex");
const url = `${WEBAPP_URL.replace(/\/$/, "")}/api/tg-webhook`;

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url, secret_token: secret, drop_pending_updates: false })
});
console.log(`setWebhook → ${url}`);
console.log(await res.json());
