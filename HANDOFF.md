# HANDOFF — полная передача проекта «ИИ-нутрициолог» (Fitness hub)

Этот файл — единственное, что нужно прочитать ИИ-ассистенту или разработчику, чтобы продолжить работу над проектом. Актуален на 2026-07-10.

## 1. Что это за продукт

Telegram-бот **@Fithub_ai_bot** + Mini App. Пользователь шлёт боту фото еды (или текст) → vision-модель распознаёт блюда и КБЖУ → запись в дневник → карточка с прогрессом дня. Mini App: онбординг с расчётом норм (Миффлин-Сан Жеор), дневник с кольцами КБЖУ, аналитика, настройки, подписка. Монетизация — Telegram Stars (Free: 3 распознавания/день; Pro: безлимит + ежедневные советы + месячная аналитика). Ежедневные ИИ-советы по cron. Язык продукта — русский.

Стадия: **работающий прод, раздаётся тестерам.** Владелец — @bbutterm (не программист: объяснять просто, шаги для дашбордов расписывать по кликам, SQL давать готовым к вставке).

## 2. Инфраструктура (что где живёт)

| Что | Где | Идентификатор |
|---|---|---|
| Репозиторий | GitHub | `bbutterm/fithub`, ветка `main`; рабочая ветка `claude/dev-clarification-questions-v6udsv` |
| Хостинг | Vercel | проект `fithub`, team `bbutterms-projects` (Hobby-план!), прод-домен **https://fithub-virid.vercel.app** |
| База | Supabase PostgreSQL | project ref `sbbfwcwkhwtvzdozddur`, регион eu-north-1 |
| Бот | Telegram | @Fithub_ai_bot, webhook → `https://fithub-virid.vercel.app/api/tg-webhook` (secret_token = sha256(BOT_TOKEN+":webhook")) |
| Vision ИИ | OpenRouter | `qwen/qwen3-vl-32b-instruct`, fallback `qwen/qwen3-vl-235b-a22b-instruct` |
| Text ИИ | DeepSeek | `deepseek-chat` |

Все секреты — в Vercel → Settings → Environment Variables (единственный источник истины). Полный список переменных с комментариями: `.env.example`. **Секретов в репозитории нет.** ⚠️ Известная проблема: текущие секреты светились в переписке — рекомендована ротация (пароль БД, PAT Supabase, BOT_TOKEN, ключи ИИ).

## 3. Архитектура (монорепо pnpm)

```
api/index.ts        Vercel-функция: ВСЕ /api/* и /health → Fastify через ДИНАМИЧЕСКИЙ import
                    (статический import ломается: ERR_REQUIRE_ESM, функция CJS, код ESM)
vercel.json         buildCommand, rewrites (/api/:path* → /api/index), headers
                    (HTML no-store — иначе Telegram WebView залипает на старой сборке),
                    crons (2 шт., лимит Hobby: раз в день)
apps/bot-api/       Node 22 + TypeScript strict + Fastify + grammY + Prisma
  src/config.ts     zod-валидация env, падает с понятной ошибкой; производные:
                    jwtSecret, webhookSecret, adminTgIds
  src/lib/ai.ts     ЕДИНСТВЕННАЯ точка вызова ИИ. Два клиента: visionClient (только фото),
                    textClient (советы/отчёты/текст еды). Таймаут 30с, 1 ретрай (эксп. пауза),
                    JSON-парсинг с 1 повтором, probe при старте (не роняет апп, подсказывает
                    имена моделей из /models), учёт каждого вызова в AiUsage (токены + costUsd)
  src/ai/food.ts    Пайплайн еды: фото (подпись = подсказка, detail:high, fallback-модель при
                    confidence < VISION_FALLBACK_THRESHOLD), текст (textClient, при 5xx/таймауте
                    деградация на visionClient; обратной подмены нет), correctMealItems
                    (уточнение ответом на карточку)
  src/bot/          grammY: /start, /day, /settings, фото/текст → карточка КБЖУ (+стрик),
                    ответ на карточку = уточнение (Meal.tgMessageId), пейволл, Stars-платежи
  src/api/server.ts REST для Mini App + webhook + cron-эндпоинты + /api/setup-webhook?key=CRON_SECRET
  src/api/admin.ts  /api/admin/*: overview (расходы ₽), users, выдача Pro, лимиты, рассылка
  src/cron/         dailyAdvice (по adviceTime в tz юзера), monthlyReport (Pro, 1-е число),
                    subscriptions (деактивация истёкших)
  src/services/     nutrition (Миффлин-Сан Жеор, scaleItem), meals, stats (паттерны, стрик),
                    limits (free-лимит + burst через AiUsage), locks (Postgres-блокировка),
                    subscription, tgfiles (getFile-прокси, кэш 30 мин), users
  prisma/           schema + миграции + seed (SEED_TG_USER_ID=... pnpm seed)
apps/webapp/        React + Vite Mini App (статика Vercel)
  src/telegram.ts   initData (sdk + fallback window.Telegram), тема → CSS-переменные, haptic
  src/api.ts        клиент: JWT в памяти, авто-переавторизация на 401,
                    Content-Type ТОЛЬКО при наличии body (иначе Fastify 400 на DELETE!)
  src/screens/      Today (свайпы, дни, кэш), MealDetail (слайдер граммов), Analytics,
                    Settings, Subscription, Admin, Onboarding
```

## 4. Ключевые решения и грабли (ОБЯЗАТЕЛЬНО к прочтению)

1. **Webhook**: Telegram ретраит update при ответе >10с → дубли. Решение: дедупликация `update_id` в Postgres (`ProcessedUpdate`, `INSERT ON CONFLICT DO NOTHING`) + гибрид: если в рантайме доступен `waitUntil` (Symbol.for("@vercel/request-context")) — ранний 200 и фон; иначе синхронная обработка. НЕ полагаться только на waitUntil — он доступен не всегда (проверено на проде).
2. **Serverless-инстансы не делят память**: блокировка «1 распознавание на юзера» и burst-лимит — в Postgres (`services/locks.ts`, `checkBurstLimit` по AiUsage). Таблицы `ProcessedUpdate` и `RecognitionLock` создаются лениво (`CREATE TABLE IF NOT EXISTS`) — миграции для них не нужны.
3. **Миграции БД**: сеть до Postgres из CI/чата может отсутствовать. Рабочий процесс: `pnpm prisma migrate dev` локально → SQL-файл миграции выполняется владельцем в Supabase SQL Editor **до мержа** + регистрация в `_prisma_migrations` (id=uuid, checksum=sha256 файла миграции, name=имя папки). Новая колонка без миграции = падение ВСЕХ Prisma-запросов этой модели.
4. **Vercel Hobby**: cron максимум 2 задачи × 1 раз/день; maxDuration 60с. Советы точно по adviceTime требуют внешнего пингера: cron-job.org → `GET /api/cron/advice` каждые 15 мин, заголовок `Authorization: Bearer <CRON_SECRET>` (дубли исключены уникальным ключом DailyAdvice). Без пингера вечерние adviceTime не сработают.
5. **Распознавание на 45с обрезается** (`Promise.race` в bot.ts) — статус-сообщение всегда получает финальный ответ до maxDuration.
6. **Кэш Telegram WebView**: HTML отдаётся с `no-store` (vercel.json headers) — не убирать, иначе пользователи видят старую сборку после деплоев.
7. **DATABASE_URL** — pooled (порт 6543, `?pgbouncer=true&connection_limit=1`), `DIRECT_URL` — session (5432). В рантайме DIRECT_URL необязателен (config подставляет DATABASE_URL).
8. **Безопасность**: единственный якорь личности — tgUserId из initData (HMAC-SHA256, TTL 24ч, подделка → 401). JWT 12ч. RLS включён на всех таблицах (Prisma работает от postgres — не задет). Админ = tgUserId ∈ ADMIN_TG_IDS.
9. **Приём оплаты — рубильник `PAYMENTS_ENABLED`** (env, без правок кода): `false` убирает кнопки покупки в боте и Mini App, `POST /api/subscription/invoice` отдаёт 403, письмо об истечении Pro не зовёт продлить. Лимиты, тарифы и выдача Pro из админки продолжают работать. Обработчики `pre_checkout_query` и `successful_payment` НЕ отключаются намеренно: у пользователя может быть открыт счёт, выставленный до отключения, — иначе Stars спишутся, а Pro не выдастся.
10. **Стоимость ИИ**: OpenRouter возвращает цену вызова (usage.cost), DeepSeek считается по тарифам из env. Всё пишется в AiUsage → админка показывает ₽ (курс USD_RUB_RATE). `VISION_FALLBACK_THRESHOLD` — главная ручка баланса точность/цена (0.7 сейчас ≈ 2 вызова на фото).

## 5. Как разрабатывать и деплоить

```bash
pnpm install
cp .env.example .env                      # локальные значения
pnpm --filter bot-api prisma:migrate      # локальный Postgres
pnpm seed                                 # тестовые данные
pnpm dev:api                              # бот long polling + API :3000 + cron в процессе
pnpm dev:webapp                           # Mini App :5173, прокси /api
pnpm typecheck && pnpm lint && pnpm test  # 20 юнит-тестов, строгий TS, без any
```

Деплой: пуш в `main` → Vercel собирает автоматически. Процесс, принятый в проекте: рабочая ветка → PR → (SQL миграции в Supabase, если есть) → squash-merge. После смены env-переменных нужен redeploy (или пустой коммит в main). Webhook переустанавливается открытием `https://fithub-virid.vercel.app/api/setup-webhook?key=<CRON_SECRET>` (нужен после смены BOT_TOKEN или домена).

Смоук после деплоя: `GET /health` → `{"ok":true}`; боту фото → карточка; ответ на карточку «сделай 300 г» → пересчёт; Mini App → свайп/кольца; админка → расходы.

## 6. Схема данных (Prisma, PostgreSQL)

`User` (tgUserId уникальный якорь, tz, dailyLimitOverride) → `Profile` 1:1 (цели КБЖУ, aллергии, тон/время советов) → `Meal` (тоталы, photoFileId + photoThumbFileId, tgMessageId для уточнений, source: photo/text/manual) → `MealItem` (позиции). `DailyAdvice` (kind daily/monthly, unique userId+date+kind), `Subscription` (pro, продление складывается), `UsageCounter` (лимит free по локальной дате юзера), `AiUsage` (учёт расходов). Вне Prisma (лениво создаются): `ProcessedUpdate`, `RecognitionLock`. Даты приёмов — UTC, «день» юзера считается по его tz (utils/tz.ts, без библиотек).

## 7. Известные недоделки / роадмап (по приоритету)

1. **cron-job.org не настроен** владельцем → вечерние советы не уходят (см. п.4.4).
2. Ротация засвеченных секретов перед публичным запуском.
3. Трекинг веса (история + график + реальная динамика в месячном отчёте — сейчас отчёту честно сообщается, что данных нет).
4. Вечернее напоминание «сегодня без записей» (retention).
5. Экспорт дневника CSV (Pro).
6. JWT в query фото-прокси попадает в логи → выделенный короткоживущий токен.
7. CORS сузить до WEBAPP_URL; тесты на сервисы (limits/subscription/stats).
8. Оплата Stars проверена только до открытия invoice (реальный платёж не совершался).

## 8. Стиль работы с владельцем

Общение по-русски, без жаргона. Дашборды объяснять по шагам («Settings → Environment Variables → ⋯ → Edit»). SQL — готовыми блоками для вставки. После каждого деплоя — короткий чек-лист «что потрогать в телефоне». Telegram-кэш побеждён (no-store), но при странностях первым делом: полностью закрыть Mini App и открыть заново.
