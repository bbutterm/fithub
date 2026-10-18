# HANDOFF — полная передача проекта «ИИ-нутрициолог» (Fitness hub)

Этот файл — единственное, что нужно прочитать ИИ-ассистенту или разработчику, чтобы продолжить работу над проектом. Актуален на 2026-09-17.

## 1. Что это за продукт

Telegram-бот **@Fithub_ai_bot** + Mini App. Пользователь шлёт боту фото еды (или текст) → vision-модель распознаёт блюда и КБЖУ → запись в дневник → карточка с прогрессом дня. Mini App: онбординг с расчётом норм (Миффлин-Сан Жеор), дневник с кольцами КБЖУ, аналитика, настройки, подписка. Монетизация — Telegram Stars (Free: 3 распознавания/день; Pro: безлимит + ежедневные советы + месячная аналитика). Ежедневные ИИ-советы по cron. Язык продукта — русский.

Стадия: **работающий прод, раздаётся тестерам.** Владелец — @bbutterm (не программист: объяснять просто, шаги для дашбордов расписывать по кликам, SQL давать готовым к вставке).

## 2. Инфраструктура (что где живёт)

| Что | Где | Идентификатор |
|---|---|---|
| Репозиторий | GitHub | `bbutterm/fithub`, ветка `main`; рабочая ветка `claude/repo-analysis-functionality-xyizqi` |
| Хостинг | Vercel | проект `fithub`, team `bbutterms-projects` (Hobby-план!), прод-домен **https://fithub-virid.vercel.app** |
| База | Supabase PostgreSQL | project ref `sbbfwcwkhwtvzdozddur`, регион eu-north-1 |
| Бот | Telegram | @Fithub_ai_bot, webhook → `https://fithub-virid.vercel.app/api/tg-webhook` (secret_token = sha256(BOT_TOKEN+":webhook")) |
| Vision ИИ | OpenRouter | `qwen/qwen3-vl-32b-instruct`, fallback `google/gemini-3.6-flash` (проверьте фактические значения в Vercel) |
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
  src/api/bench.ts  /api/bench — стенд сравнения vision-моделей: загрузить фото, прогнать
                    через набор моделей, сравнить цену и результат. Открыт БЕЗ пароля,
                    защита баланса — дневной потолок расходов (features.ts)
  src/diets.ts      справочник лечебных режимов питания (стол №5, средиземноморская и др.).
                    В промпт уходят ПРАВИЛА режима текстом, а не название: иначе модель
                    отвечает по памяти и каждый раз по-разному
  src/ai/dietCheck.ts  отдельный дешёвый текстовый вызов «вписывается ли приём в режим».
                    Не подмешан в vision-промпт: смешивание портит и распознавание, и оценку.
                    Режим не задан → вызова нет вовсе
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
3. **Миграции БД**: с 19.09.2026 `vercel.json` запускает `prisma migrate deploy` в начале сборки, но **только при `VERCEL_ENV=production`** (нужен `DIRECT_URL` в env Vercel; порт 5432, session pooler). Preview-сборки веток базу не трогают: переменные окружения в проекте общие для всех окружений, и preview вместе с production одновременно накатывали миграции на боевую базу — одна сборка забирала advisory-lock Prisma, вторая падала. Упала миграция — упала сборка, прошлый деплой остаётся жить. Пишите миграции идемпотентно (`IF NOT EXISTS`, `DO $$ … $$` для constraint'ов): часть из них когда-то накатывалась руками через панель/MCP, и повтор не должен падать. Ручной путь на случай, если сборочный не сработает: SQL-файл в Supabase SQL Editor + запись в `_prisma_migrations` (id=uuid, checksum=sha256 файла, name=имя папки). Новая колонка без миграции = падение ВСЕХ Prisma-запросов этой модели.
4. **Cron и maxDuration 60с**: `/api/cron/advice` зарегистрирован 24 раза — по разу на каждый час UTC, потому что тик пропускает пользователя, у которого локальное время ещё не дошло до `adviceTime`. Один запуск в сутки означал, что все, кроме попавших ровно в 09:00 МСК, не получали совет никогда. Повторные запуски безопасны: дубли исключает уникальный ключ DailyAdvice. Если тариф Vercel не даст столько задач — перенести почасовой вызов на внешний планировщик с заголовком `Authorization: Bearer <CRON_SECRET>`.
5. **Распознавание на 45с обрезается** (`Promise.race` в bot.ts) — статус-сообщение всегда получает финальный ответ до maxDuration.
6. **Кэш Telegram WebView**: HTML отдаётся с `no-store` (vercel.json headers) — не убирать, иначе пользователи видят старую сборку после деплоев.
7. **DATABASE_URL** — pooled (порт 6543, `?pgbouncer=true&connection_limit=1`), `DIRECT_URL` — session (5432). В рантайме DIRECT_URL необязателен (config подставляет DATABASE_URL).
8. **Безопасность**: единственный якорь личности — tgUserId из initData (HMAC-SHA256, TTL 24ч, подделка → 401). JWT 12ч, только в заголовке. Ссылки на фото подписываются отдельным коротким токеном (`auth/photoToken.ts`, час жизни, право только на одно фото) — сессионный JWT в адресе картинки уезжал в логи. RLS включён на всех таблицах и закреплён миграцией `20260901000000_enable_rls`; до 17.09.2026 его не было нигде, хотя предыдущая версия этого файла утверждала обратное. Prisma ходит владельцем таблиц, политик нет и не нужно. Админ = tgUserId ∈ ADMIN_TG_IDS.
9. **Стоимость ИИ**: OpenRouter возвращает цену вызова (usage.cost), DeepSeek считается по тарифам из env. Всё пишется в AiUsage → админка показывает ₽ (курс USD_RUB_RATE). `VISION_FALLBACK_THRESHOLD` — главная ручка баланса точность/цена (0.7 сейчас ≈ 2 вызова на фото).

## 5. Как разрабатывать и деплоить

```bash
pnpm install
cp .env.example .env                      # локальные значения
pnpm --filter bot-api prisma:migrate      # локальный Postgres
pnpm seed                                 # тестовые данные
pnpm dev:api                              # бот long polling + API :3000 + cron в процессе
pnpm dev:webapp                           # Mini App :5173, прокси /api
pnpm typecheck && pnpm lint && pnpm test  # строгий TS, без any, 132 юнит-теста
pnpm test:integration                     # 112 тестов на настоящей базе — см. docs/TESTING.md
```

Проверки гоняются автоматически: `.github/workflows/ci.yml` на каждый пуш и PR — typecheck, lint, юнит-тесты, интеграционные тесты на сервисном PostgreSQL, сборка Mini App и накат всех миграций на чистую базу.

Как устроен код — `docs/ARCHITECTURE.md`. Что и чем покрыто — `docs/TESTING.md`.

Деплой: пуш в `main` → Vercel собирает автоматически, миграции накатываются в сборке (см. п. 4.3). Процесс, принятый в проекте: рабочая ветка → PR → squash-merge. После смены env-переменных нужен redeploy (или пустой коммит в main). Webhook переустанавливается открытием `https://fithub-virid.vercel.app/api/setup-webhook?key=<CRON_SECRET>` (нужен после смены BOT_TOKEN или домена).

Смоук после деплоя: `GET /health` → `{"ok":true}`; боту фото → карточка; ответ на карточку «сделай 300 г» → пересчёт; Mini App → свайп/кольца; админка → расходы.

## 6. Схема данных (Prisma, PostgreSQL)

`User` (tgUserId уникальный якорь, tz, dailyLimitOverride) → `Profile` 1:1 (цели КБЖУ, аллергии, тон/время советов, `medicalDiets` + `dietNotes` — лечебные режимы питания) → `Meal` (тоталы, photoFileId + photoThumbFileId, tgMessageId для уточнений, source: photo/text/manual) → `MealItem` (позиции). `DailyAdvice` (kind daily/monthly, unique userId+date+kind), `Subscription` (pro, продление складывается), `UsageCounter` (лимит free по локальной дате юзера), `AiUsage` (учёт расходов). Вне Prisma (лениво создаются): `ProcessedUpdate`, `RecognitionLock`. Даты приёмов — UTC, «день» юзера считается по его tz (utils/tz.ts, без библиотек).

## 7. Известные недоделки / роадмап (по приоритету)

Закрыто 17.09.2026: почасовой запуск советов, RLS на всех таблицах, подпись для фото вместо JWT в URL, удаление аккаунта, атомарный лимит распознаваний, рассылка пачками, CI, режим лечебных диет.
Закрыто 19.09.2026: вечернее напоминание, режим «можно?», действие в совете дня, миграции в сборке Vercel.
Закрыто 18.10.2026: тесты на маршруты API, сервисы и обработчики бота (112 интеграционных в CI), первые тесты Mini App, разбор `bot.ts` на модули, проверка выполнимости челленджа при создании, проверка часового пояса профиля.

1. **Ротация засвеченных секретов** не подтверждена. Важно: `jwtSecret` и `webhookSecret` выводятся из `BOT_TOKEN` (`config.ts`), то есть утечка токена бота = подделка сессий Mini App. Задать явный `JWT_SECRET`.
2. **Защита ветки `main`** — в неё пушат трое, включая агента на VPS.
3. **Нет сигнала о поломке**: бот однажды молчал три недели, заметили случайно. Нужна ежедневная проверка вебхука с сообщением админу.
4. **Лента еды — заготовка**: схема и сервис есть и покрыты тестами, API и экрана нет. Доделать или убрать из `main`.
5. **Mini App без браузерных тестов**: покрыта только чистая логика. `scripts/ui-smoke.py` в CI не ходит.
6. Трекинг веса (месячный отчёт сейчас честно сообщает, что данных нет).
7. Экспорт дневника CSV — нужен и сам по себе, и перед удалением аккаунта.
8. Оплата Stars проверена только до открытия invoice; сейчас выключена.
9. Data API (PostgREST) в Supabase приложению не нужен — можно убрать `public` из Exposed schemas.
10. Prisma 6 → 7 и прочие мажорные обновления. Заодно: в модели `Meal` осталась неиспользуемая колонка `photoS3Key` (S3 не используется) — удалять только отдельной миграцией и осознанно.

## 8. Стиль работы с владельцем

Общение по-русски, без жаргона. Дашборды объяснять по шагам («Settings → Environment Variables → ⋯ → Edit»). SQL — готовыми блоками для вставки. После каждого деплоя — короткий чек-лист «что потрогать в телефоне». Telegram-кэш побеждён (no-store), но при странностях первым делом: полностью закрыть Mini App и открыть заново.
