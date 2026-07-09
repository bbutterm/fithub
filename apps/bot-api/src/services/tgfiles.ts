import { config } from "../config.js";
import { logger } from "../logger.js";

// Кэш file_path из Bot API getFile — 30 минут (сами ссылки Telegram живут ~1 час).
const FILE_PATH_TTL_MS = 30 * 60 * 1000;
const filePathCache = new Map<string, { path: string; expiresAt: number }>();

async function getFilePath(fileId: string): Promise<string> {
  const cached = filePathCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return cached.path;

  const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const data = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
  const path = data.result?.file_path;
  if (!data.ok || !path) throw new Error(`getFile failed for ${fileId}`);
  filePathCache.set(fileId, { path, expiresAt: Date.now() + FILE_PATH_TTL_MS });
  if (filePathCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of filePathCache) if (v.expiresAt <= now) filePathCache.delete(k);
  }
  return path;
}

/** Скачивание файла Telegram в память (для vision-запроса и фото-прокси). */
export async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const path = await getFilePath(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${path}`);
  if (!res.ok) {
    filePathCache.delete(fileId);
    throw new Error(`file download failed: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? (path.endsWith(".png") ? "image/png" : "image/jpeg");
  logger.debug({ fileId, bytes: buffer.length }, "telegram file downloaded");
  return { buffer, contentType };
}

export async function telegramFileToDataUrl(fileId: string): Promise<string> {
  const { buffer, contentType } = await downloadTelegramFile(fileId);
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}
