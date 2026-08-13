// Стенд сравнения vision-моделей: отдельная страница вне Telegram.
// Загружаете фото — оно по очереди уходит в выбранные модели, по каждой видно
// результат распознавания, фактическую цену вызова и время ответа.
//
// Доступ: GET /api/bench — открыт всем, пароля нет.
// Баланс защищён единственным ограничителем: дневным потолком расходов стенда
// (features.ts → BENCH_DAILY_USD_LIMIT). Страница закрыта от индексации.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { BENCH_DAILY_USD_LIMIT } from "../features.js";
import { visionClient, type ChatMessage } from "../lib/ai.js";
import { foodResponseSchema } from "../ai/food.js";
import { buildPhotoHint, JSON_RETRY_PROMPT, VISION_SYSTEM_PROMPT } from "../prompts/vision.js";

/**
 * Кандидаты по умолчанию — только проверенные на практике имена.
 * Остальные модели добавляются на странице из живого каталога провайдера:
 * угадывать имена по обзорам бессмысленно, они не совпадают.
 * Строки с «#» — комментарии.
 */
const DEFAULT_MODELS = [
  "# ваши текущие",
  config.VISION_MODEL,
  config.VISION_MODEL_FALLBACK,
  "# показали себя лучше",
  "minimax/minimax-m3",
  "google/gemini-3.6-flash"
];

// Один вызов должен уложиться в лимит serverless-функции (60 с) с запасом на сеть
const BENCH_TIMEOUT_MS = 25_000;

/** Сколько стенд потратил за текущие сутки (UTC). Считается по учёту расходов. */
async function spentTodayUsd(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  try {
    const agg = await prisma.aiUsage.aggregate({
      _sum: { costUsd: true },
      where: { purpose: "bench", createdAt: { gte: startOfDay } }
    });
    return agg._sum.costUsd ?? 0;
  } catch (err) {
    // Если БД недоступна — не блокируем стенд, но и не теряем сигнал
    logger.warn({ err: String(err) }, "bench spend check failed");
    return 0;
  }
}

export function registerBenchRoutes(app: FastifyInstance): void {
  // --- Страница стенда ---
  app.get("/api/bench", async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-store")
      // страница тратит деньги — в поиске ей делать нечего
      .header("X-Robots-Tag", "noindex, nofollow")
      .send(renderPage());
  });

  // --- Список доступных моделей провайдера с актуальными ценами ---
  // Снимает главную боль: точные имена моделей меняются, гадать не нужно.
  app.get("/api/bench/models", async (request, reply) => {
    const query = request.query as { q?: string; ids?: string };
    const q = (query.q ?? "").trim().toLowerCase();
    // ?ids=a,b,c — проверка конкретных имён: существуют ли и принимают ли картинки.
    // Нужна, чтобы опечатка в имени выяснялась до прогона, а не молчаливым отказом.
    const ids = (query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`${config.VISION_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${config.VISION_API_KEY}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) return reply.code(502).send({ error: "provider_error", status: res.status });
      const data = (await res.json()) as {
        data?: Array<{
          id?: string;
          architecture?: { input_modalities?: string[] };
          pricing?: { prompt?: string; completion?: string };
        }>;
      };
      const all = data.data ?? [];

      if (ids.length) {
        const byId = new Map(all.map((m) => [m.id ?? "", m]));
        return {
          checked: ids.map((id) => {
            const m = byId.get(id);
            return {
              id,
              exists: Boolean(m),
              image: Boolean(m?.architecture?.input_modalities?.includes("image")),
              inPer1M: Number(m?.pricing?.prompt ?? 0) * 1e6,
              outPer1M: Number(m?.pricing?.completion ?? 0) * 1e6
            };
          })
        };
      }

      const models = all
        // только те, что принимают картинки — остальные для распознавания еды бесполезны
        .filter((m) => m.architecture?.input_modalities?.includes("image"))
        .filter((m) => (q ? (m.id ?? "").toLowerCase().includes(q) : true))
        .map((m) => ({
          id: m.id ?? "",
          // провайдер отдаёт цену за токен — переводим в привычные $/1M
          inPer1M: Number(m.pricing?.prompt ?? 0) * 1e6,
          outPer1M: Number(m.pricing?.completion ?? 0) * 1e6
        }))
        .filter((m) => m.id)
        .sort((a, b) => a.inPer1M - b.inPer1M)
        .slice(0, 200);
      return { models };
    } catch (err) {
      logger.warn({ err: String(err) }, "bench models list failed");
      return reply.code(502).send({ error: "provider_unreachable" });
    }
  });

  // --- Прогон одного фото через одну модель ---
  // Одна модель на запрос: семь моделей в одной функции не уложились бы в 60 секунд.
  app.post("/api/bench/run", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const parsed = z
      .object({
        model: z.string().min(1).max(120),
        imageDataUrl: z.string().startsWith("data:image/"),
        caption: z.string().max(300).optional()
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const { model, imageDataUrl, caption } = parsed.data;

    // Единственная защита открытой страницы: дневной потолок расходов стенда
    const spent = await spentTodayUsd();
    if (spent >= BENCH_DAILY_USD_LIMIT) {
      return reply.code(429).send({
        ok: false,
        error: `Дневной лимит стенда исчерпан: потрачено $${spent.toFixed(3)} из $${BENCH_DAILY_USD_LIMIT}. Счётчик обнулится завтра, поднять потолок — apps/bot-api/src/features.ts.`,
        spentTodayUsd: spent,
        limitUsd: BENCH_DAILY_USD_LIMIT
      });
    }

    const messages: ChatMessage[] = [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: caption?.trim() ? buildPhotoHint(caption.trim()) : "Проанализируй фото еды." },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }
        ]
      }
    ];

    const startedAt = Date.now();
    try {
      // Тот же путь, что и в проде: та же схема, тот же промпт, только модель другая
      const res = await visionClient.chatCompletionJson(messages, foodResponseSchema, JSON_RETRY_PROMPT, {
        model,
        timeoutMs: BENCH_TIMEOUT_MS,
        attribution: { purpose: "bench" } // отдельная строка в учёте расходов, не мешается с боевыми
      });
      return {
        ok: true,
        model,
        latencyMs: res.latencyMs,
        costUsd: res.costUsd,
        usage: res.usage,
        result: res.value,
        spentTodayUsd: spent + res.costUsd,
        limitUsd: BENCH_DAILY_USD_LIMIT
      };
    } catch (err) {
      // Ошибку конкретной модели показываем в её карточке, остальные продолжают прогон
      return { ok: false, model, latencyMs: Date.now() - startedAt, error: String(err).slice(0, 400) };
    }
  });
}

function renderPage(): string {
  const models = JSON.stringify(DEFAULT_MODELS);
  const rate = config.USD_RUB_RATE;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Стенд моделей — распознавание еды</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f4f6f9; --card: #fff; --text: #14161a; --hint: #6b7280;
    --line: #e3e7ee; --brand: #1baf7a; --warn: #eda100; --bad: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101215; --card: #181b20; --text: #eceef2; --hint: #9aa1ad; --line: #262a31; --brand: #22c489; }
  }
  body { background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; }
  .wrap { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .hint { color: var(--hint); font-size: 14px; }
  .small { font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
  label.f { display: block; margin-bottom: 10px; }
  label.f > span { display: block; font-size: 13px; color: var(--hint); margin-bottom: 4px; }
  input[type=text], textarea, input[type=file] { width: 100%; padding: 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; font-size: 15px; }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; min-height: 132px; resize: vertical; }
  button { padding: 12px 16px; border: none; border-radius: 12px; background: var(--brand); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button.sec { background: transparent; color: var(--brand); border: 1px solid var(--brand); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  img.prev { width: 100%; max-height: 320px; object-fit: contain; border-radius: 12px; background: var(--bg); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); }
  th { color: var(--hint); font-weight: 500; font-size: 12px; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .badge { font-size: 12px; padding: 3px 8px; border-radius: 8px; background: var(--bg); color: var(--hint); white-space: nowrap; }
  .badge.ok { background: color-mix(in srgb, var(--brand) 16%, transparent); color: var(--brand); }
  .badge.err { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
  .head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; margin-bottom: 6px; }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--brand); border-radius: 50%; animation: sp .8s linear infinite; vertical-align: -2px; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .list { max-height: 260px; overflow: auto; margin-top: 8px; }
  .list div { padding: 6px 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 8px; cursor: pointer; }
  .win { border-color: var(--brand); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Стенд моделей</h1>
  <p class="hint">Одно фото — сколько угодно моделей. Цена и время берутся фактические, из ответа провайдера. Расходы ограничены дневным потолком.</p>

  <div class="card" style="margin-top:12px">
    <label class="f"><span>Фото еды</span><input type="file" id="file" accept="image/*" /></label>
    <img id="prev" class="prev" style="display:none" alt="" />
    <label class="f" style="margin-top:10px"><span>Подпись (необязательно — как подпись к фото в боте)</span>
      <input type="text" id="caption" placeholder="борщ с хлебом" /></label>
    <label class="f"><span>Модели — по одной в строке, строки с # игнорируются</span><textarea id="models"></textarea></label>
    <label class="f"><span>Повторов каждой моделью (разброс между запусками бывает больше, чем между моделями)</span>
      <select id="repeats"><option value="1">1 — быстро</option><option value="2">2</option><option value="3">3 — видно разброс</option></select></label>
    <div class="row">
      <button id="run">Прогнать</button>
      <button id="check" class="sec">Проверить имена</button>
      <button id="find" class="sec">Каталог моделей</button>
      <button id="reset" class="sec">Список по умолчанию</button>
    </div>
    <div id="checked" class="small" style="margin-top:10px"></div>
    <div id="finder" style="display:none">
      <p class="hint small" style="margin-top:12px">Все модели провайдера, которые принимают картинки, с актуальными ценами за 1M токенов. Отметьте нужные и добавьте в список.</p>
      <div class="row" style="margin:8px 0">
        <input type="text" id="q" placeholder="qwen, gemini, minimax…" style="flex:1" />
        <button id="sort" class="sec">Сначала дорогие</button>
      </div>
      <div class="list" id="found"></div>
      <button id="addSel" style="margin-top:10px">Добавить отмеченные</button>
    </div>
  </div>

  <div id="out"></div>
  <div id="sum"></div>
</div>
<script>
(function () {
  var RATE = ${rate};
  var DEFAULTS = ${models};
  var img = null;
  var budget = null; // {spentTodayUsd, limitUsd} — приходит с каждым ответом прогона

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function n1(v) { return (Math.round(Number(v) * 10) / 10).toString(); }
  function money(usd) { return '$' + Number(usd).toFixed(5) + ' · ' + (Number(usd) * RATE).toFixed(3) + ' ₽'; }

  // Список моделей: пустые строки и комментарии (#) отбрасываем
  function modelList() {
    return $('models').value.split('\\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.charAt(0) !== '#'; });
  }

  var saved = localStorage.getItem('benchModels');
  $('models').value = saved || DEFAULTS.join('\\n');
  $('models').addEventListener('input', function () { localStorage.setItem('benchModels', $('models').value); });
  $('reset').addEventListener('click', function () {
    $('models').value = DEFAULTS.join('\\n');
    localStorage.setItem('benchModels', $('models').value);
  });

  // Ужимаем до 1280 px — примерно такой размер и приходит из Telegram, плюс запрос не разбухает
  $('file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      var im = new Image();
      im.onload = function () {
        var max = 1280;
        var k = Math.min(1, max / Math.max(im.width, im.height));
        var c = document.createElement('canvas');
        c.width = Math.round(im.width * k);
        c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        img = c.toDataURL('image/jpeg', 0.85);
        $('prev').src = img;
        $('prev').style.display = 'block';
      };
      im.src = String(fr.result);
    };
    fr.readAsDataURL(f);
  });

  // Проверка имён без единого платного вызова: сверяем список с каталогом провайдера
  $('check').addEventListener('click', function () {
    var list = modelList();
    if (!list.length) { alert('Список моделей пуст'); return; }
    $('checked').innerHTML = '<span class="hint">Проверяю…</span>';
    fetch('/api/bench/models?ids=' + encodeURIComponent(list.join(',')))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.checked) { $('checked').innerHTML = '<span class="hint">Не удалось проверить</span>'; return; }
        $('checked').innerHTML = d.checked.map(function (m) {
          if (!m.exists) return '<div><span class="badge err">нет такой</span> <span class="mono">' + esc(m.id) + '</span></div>';
          if (!m.image) return '<div><span class="badge err">без картинок</span> <span class="mono">' + esc(m.id) + '</span></div>';
          return '<div><span class="badge ok">есть</span> <span class="mono">' + esc(m.id) + '</span> <span class="badge">$' +
            m.inPer1M.toFixed(3) + ' / $' + m.outPer1M.toFixed(3) + '</span></div>';
        }).join('');
      })
      .catch(function () { $('checked').innerHTML = '<span class="hint">Не удалось проверить</span>'; });
  });

  $('find').addEventListener('click', function () {
    var box = $('finder');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    if (box.style.display === 'block') loadModels('');
  });
  var t = null;
  $('q').addEventListener('input', function () {
    clearTimeout(t);
    t = setTimeout(function () { loadModels($('q').value); }, 350);
  });

  var descending = false; // порядок каталога: дешёвые сверху или дорогие
  $('sort').addEventListener('click', function () {
    descending = !descending;
    $('sort').textContent = descending ? 'Сначала дешёвые' : 'Сначала дорогие';
    loadModels($('q').value);
  });

  $('addSel').addEventListener('click', function () {
    var picked = Array.prototype.slice.call($('found').querySelectorAll('input:checked')).map(function (c) { return c.value; });
    if (!picked.length) { alert('Ничего не отмечено'); return; }
    var lines = $('models').value.split('\\n');
    var have = lines.map(function (s) { return s.trim(); });
    picked.forEach(function (id) { if (have.indexOf(id) === -1) lines.push(id); });
    $('models').value = lines.join('\\n');
    localStorage.setItem('benchModels', $('models').value);
    $('checked').innerHTML = '<span class="badge ok">добавлено моделей: ' + picked.length + '</span>';
  });

  function loadModels(q) {
    $('found').innerHTML = '<div class="hint small">Загружаю каталог…</div>';
    fetch('/api/bench/models?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.error) { $('found').innerHTML = '<div class="hint small">Каталог недоступен (' + esc(d.error) + '). Попробуйте ещё раз.</div>'; return; }
        var list = (d && d.models) || [];
        if (!list.length) { $('found').innerHTML = '<div class="hint small">Ничего не найдено</div>'; return; }
        if (descending) list = list.slice().reverse();
        $('found').innerHTML = list.map(function (m) {
          return '<div><label style="display:flex;gap:8px;align-items:center;flex:1;cursor:pointer">' +
            '<input type="checkbox" value="' + esc(m.id) + '" />' +
            '<span class="mono">' + esc(m.id) + '</span></label>' +
            '<span class="badge">$' + m.inPer1M.toFixed(3) + ' / $' + m.outPer1M.toFixed(3) + '</span></div>';
        }).join('');
      })
      .catch(function () { $('found').innerHTML = '<div class="hint small">Не удалось получить каталог</div>'; });
  }

  $('run').addEventListener('click', function () {
    if (!img) { alert('Сначала выберите фото'); return; }
    var models = modelList();
    if (!models.length) { alert('Список моделей пуст'); return; }
    var repeats = Number($('repeats').value) || 1;
    var jobs = [];
    models.forEach(function (m) {
      for (var k = 1; k <= repeats; k++) jobs.push({ model: m, run: k, of: repeats });
    });

    $('run').disabled = true;
    $('out').innerHTML = '';
    $('sum').innerHTML = '';
    var results = [];

    // Строго по очереди: так видно, кто отвечает быстро, и не бьём провайдера пачкой
    var i = 0;
    (function next() {
      if (i >= jobs.length) { $('run').disabled = false; summary(results); return; }
      var job = jobs[i++];
      var model = job.model;
      var label = model + (job.of > 1 ? ' · прогон ' + job.run + '/' + job.of : '');
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = '<div class="head"><span class="mono">' + esc(label) + '</span><span class="badge"><span class="spin"></span> идёт</span></div>';
      $('out').appendChild(card);
      var t0 = Date.now();
      fetch('/api/bench/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model, imageDataUrl: img, caption: $('caption').value })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.limitUsd != null) budget = { spent: d.spentTodayUsd, limit: d.limitUsd };
          render(card, label, d, Date.now() - t0);
          if (d && d.ok) {
            var kcal = ((d.result && d.result.items) || []).reduce(function (s, it) { return s + (+it.kcal || 0); }, 0);
            results.push({ model: model, costUsd: d.costUsd, latencyMs: d.latencyMs, kcal: kcal });
          }
        })
        .catch(function (e) { render(card, label, { ok: false, error: String(e) }, Date.now() - t0); })
        .then(next);
    })();
  });

  function render(card, model, d, wallMs) {
    if (!d || !d.ok) {
      card.innerHTML = '<div class="head"><span class="mono">' + esc(model) + '</span><span class="badge err">ошибка</span></div>' +
        '<div class="hint small mono">' + esc((d && d.error) || 'нет ответа') + '</div>';
      return;
    }
    var r = d.result || {};
    var items = r.items || [];
    var sum = items.reduce(function (a, it) {
      return { kcal: a.kcal + (+it.kcal || 0), p: a.p + (+it.protein || 0), f: a.f + (+it.fat || 0), c: a.c + (+it.carbs || 0) };
    }, { kcal: 0, p: 0, f: 0, c: 0 });

    var rows = items.map(function (it) {
      return '<tr><td>' + esc(it.dish) + '</td><td class="n">' + n1(it.grams) + ' г</td><td class="n">' + n1(it.kcal) +
        '</td><td class="n">' + n1(it.protein) + ' / ' + n1(it.fat) + ' / ' + n1(it.carbs) + '</td></tr>';
    }).join('');

    card.innerHTML =
      '<div class="head"><span class="mono">' + esc(model) + '</span>' +
      '<span class="row"><span class="badge ok">' + money(d.costUsd) + '</span>' +
      '<span class="badge">' + (wallMs / 1000).toFixed(1) + ' с</span></span></div>' +
      (items.length
        ? '<table><thead><tr><th>Блюдо</th><th class="n">Вес</th><th class="n">Ккал</th><th class="n">Б / Ж / У</th></tr></thead><tbody>' +
          rows + '</tbody></table>' +
          '<p class="small" style="margin-top:8px"><b>Итого: ' + n1(sum.kcal) + ' ккал</b> · Б ' + n1(sum.p) +
          ' / Ж ' + n1(sum.f) + ' / У ' + n1(sum.c) + '</p>'
        : '<p class="hint small">Еда не распознана' + (r.error ? ' (' + esc(r.error) + ')' : '') + '</p>') +
      '<p class="hint small" style="margin-top:6px">уверенность ' + (r.overall_confidence != null ? r.overall_confidence : '—') +
      ' · токенов ' + ((d.usage && d.usage.promptTokens) || 0) + ' + ' + ((d.usage && d.usage.completionTokens) || 0) + '</p>' +
      (r.comment ? '<p class="hint small" style="margin-top:6px">💬 ' + esc(r.comment) + '</p>' : '') +
      (r.observed ? '<p class="hint small" style="margin-top:6px">👁 ' + esc(r.observed) + '</p>' : '');
  }

  function budgetLine() {
    if (!budget) return '';
    var left = Math.max(0, budget.limit - budget.spent);
    return '<p class="hint small" style="margin-top:8px">Дневной лимит стенда: потрачено $' + Number(budget.spent).toFixed(3) +
      ' из $' + Number(budget.limit).toFixed(2) + ', осталось примерно ' + Math.floor(left / 0.005) + ' прогонов.</p>';
  }

  function summary(res) {
    if (!res.length) { if (budget) $('sum').innerHTML = '<div class="card">' + budgetLine() + '</div>'; return; }

    // Группируем по модели: при нескольких повторах видно и разброс внутри модели
    var by = {};
    res.forEach(function (r) {
      if (!by[r.model]) by[r.model] = { model: r.model, cost: 0, ms: 0, n: 0, kcals: [] };
      var g = by[r.model];
      g.cost += r.costUsd; g.ms += r.latencyMs; g.n += 1; g.kcals.push(r.kcal);
    });
    var groups = Object.keys(by).map(function (k) {
      var g = by[k];
      g.avgCost = g.cost / g.n;
      g.avgMs = g.ms / g.n;
      g.min = Math.min.apply(null, g.kcals);
      g.max = Math.max.apply(null, g.kcals);
      return g;
    });

    var rows = groups.slice().sort(function (a, b) { return a.avgCost - b.avgCost; }).map(function (g) {
      var spread = g.n > 1 ? Math.round(g.min) + '–' + Math.round(g.max) : Math.round(g.min);
      return '<tr><td class="mono" style="font-size:12px">' + esc(g.model) + '</td>' +
        '<td class="n">' + spread + '</td>' +
        '<td class="n">' + money(g.avgCost) + '</td>' +
        '<td class="n">' + (g.avgMs / 1000).toFixed(1) + ' с</td></tr>';
    }).join('');

    var all = res.map(function (r) { return r.kcal; });
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    var total = res.reduce(function (s, r) { return s + r.costUsd; }, 0);
    var wobbly = groups.filter(function (g) { return g.n > 1 && g.min > 0 && g.max / g.min >= 1.25; });

    $('sum').innerHTML = '<div class="card"><b>Итоги прогона</b>' +
      '<table><thead><tr><th>Модель</th><th class="n">Ккал</th><th class="n">Цена</th><th class="n">Время</th></tr></thead><tbody>' +
      rows + '</tbody></table>' +
      '<p class="small" style="margin-top:8px">Разброс между всеми: ' + Math.round(min) + '–' + Math.round(max) + ' ккал' +
      (min > 0 ? ' (×' + (max / min).toFixed(1) + ')' : '') + ' · весь прогон ' + money(total) + '</p>' +
      (wobbly.length
        ? '<p class="small" style="margin-top:8px">⚠️ Сама с собой не сходится: ' +
          wobbly.map(function (g) { return '<span class="mono">' + esc(g.model) + '</span>'; }).join(', ') +
          ' — на одном и том же фото разные ответы. Такую модель нельзя судить по одному прогону.</p>'
        : '') +
      '<p class="hint small" style="margin-top:8px">Дорогая модель оправдана только там, где она реально ближе к правде. Сверьте граммы с тем, что было на тарелке.</p>' +
      budgetLine() + '</div>';
  }
})();
</script>
</body>
</html>`;
}
