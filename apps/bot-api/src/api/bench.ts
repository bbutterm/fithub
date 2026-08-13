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

/** Кандидаты по умолчанию. Список правится прямо на странице — имена моделей можно найти поиском. */
const DEFAULT_MODELS = [
  config.VISION_MODEL,
  config.VISION_MODEL_FALLBACK,
  "qwen/qwen3.7-flash",
  "qwen/qwen3-vl-flash",
  "minimax/minimax-m3",
  "google/gemini-2.5-flash",
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
    const q = ((request.query as { q?: string }).q ?? "").trim().toLowerCase();
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
      const models = (data.data ?? [])
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
        .slice(0, 60);
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
  <p class="hint">Одно фото — семь моделей. Цена и время берутся фактические, из ответа провайдера. Расходы ограничены дневным потолком.</p>

  <div class="card" style="margin-top:12px">
    <label class="f"><span>Фото еды</span><input type="file" id="file" accept="image/*" /></label>
    <img id="prev" class="prev" style="display:none" alt="" />
    <label class="f" style="margin-top:10px"><span>Подпись (необязательно — как подпись к фото в боте)</span>
      <input type="text" id="caption" placeholder="борщ с хлебом" /></label>
    <label class="f"><span>Модели — по одной в строке</span><textarea id="models"></textarea></label>
    <div class="row">
      <button id="run">Прогнать</button>
      <button id="find" class="sec">Найти модели</button>
      <button id="reset" class="sec">Список по умолчанию</button>
    </div>
    <div id="finder" style="display:none">
      <label class="f" style="margin-top:12px"><span>Поиск по имени (только модели с поддержкой картинок)</span>
        <input type="text" id="q" placeholder="qwen, gemini, minimax…" /></label>
      <div class="list" id="found"></div>
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

  function loadModels(q) {
    $('found').innerHTML = '<div class="hint small">Загружаю…</div>';
    fetch('/api/bench/models?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.models || !d.models.length) { $('found').innerHTML = '<div class="hint small">Ничего не найдено</div>'; return; }
        $('found').innerHTML = d.models.map(function (m) {
          return '<div data-id="' + esc(m.id) + '"><span class="mono">' + esc(m.id) + '</span>' +
            '<span class="badge">$' + m.inPer1M.toFixed(3) + ' / $' + m.outPer1M.toFixed(3) + '</span></div>';
        }).join('');
        Array.prototype.forEach.call($('found').children, function (el) {
          el.addEventListener('click', function () {
            var id = el.getAttribute('data-id');
            var cur = $('models').value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
            if (cur.indexOf(id) === -1) cur.push(id);
            $('models').value = cur.join('\\n');
            localStorage.setItem('benchModels', $('models').value);
          });
        });
      })
      .catch(function () { $('found').innerHTML = '<div class="hint small">Не удалось получить список</div>'; });
  }

  $('run').addEventListener('click', function () {
    if (!img) { alert('Сначала выберите фото'); return; }
    var models = $('models').value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!models.length) { alert('Список моделей пуст'); return; }
    $('run').disabled = true;
    $('out').innerHTML = '';
    $('sum').innerHTML = '';
    var results = [];

    // Строго по очереди: так видно, кто отвечает быстро, и не бьём провайдера пачкой
    var i = 0;
    (function next() {
      if (i >= models.length) { $('run').disabled = false; summary(results); return; }
      var model = models[i++];
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = '<div class="head"><span class="mono">' + esc(model) + '</span><span class="badge"><span class="spin"></span> идёт</span></div>';
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
          render(card, model, d, Date.now() - t0);
          if (d && d.ok) results.push(d);
        })
        .catch(function (e) { render(card, model, { ok: false, error: String(e) }, Date.now() - t0); })
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
    if (res.length < 2) { if (budget) $('sum').innerHTML = '<div class="card">' + budgetLine() + '</div>'; return; }
    var byCost = res.slice().sort(function (a, b) { return a.costUsd - b.costUsd; });
    var byTime = res.slice().sort(function (a, b) { return a.latencyMs - b.latencyMs; });
    var kcal = res.map(function (d) {
      return (d.result && d.result.items || []).reduce(function (s, i) { return s + (+i.kcal || 0); }, 0);
    });
    var min = Math.min.apply(null, kcal), max = Math.max.apply(null, kcal);
    var total = res.reduce(function (s, d) { return s + d.costUsd; }, 0);
    $('sum').innerHTML = '<div class="card"><b>Итоги прогона</b>' +
      '<p class="small" style="margin-top:8px">Дешевле всех: <span class="mono">' + esc(byCost[0].model) + '</span> — ' + money(byCost[0].costUsd) + '</p>' +
      '<p class="small">Быстрее всех: <span class="mono">' + esc(byTime[0].model) + '</span> — ' + (byTime[0].latencyMs / 1000).toFixed(1) + ' с</p>' +
      '<p class="small">Разброс по калориям: ' + Math.round(min) + '–' + Math.round(max) + ' ккал' +
      (min > 0 ? ' (×' + (max / min).toFixed(1) + ')' : '') + '</p>' +
      '<p class="small">Весь прогон обошёлся в ' + money(total) + '</p>' +
      '<p class="hint small" style="margin-top:8px">Дорогая модель оправдана только там, где она реально ближе к правде. Сверьте граммы с тем, что было на тарелке.</p>' +
      budgetLine() + '</div>';
  }
})();
</script>
</body>
</html>`;
}
