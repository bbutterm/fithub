# Changelog

## Unreleased

### Eval toolkit for food recognition models

- Added `apps/bot-api/eval`: a runnable toolkit for comparing vision models on a labelled photo set — dataset validation, image normalisation, a resumable run, blind dish labelling and scoring.
- The run uses the bot's own prompt and parsing schema (`src/prompts/vision.ts`, the new `src/ai/foodSchema.ts`), a fixed temperature and identical images, so it measures the bot rather than a separate setup. Every call stores the raw answer, latency, tokens, cost and failure kind; network retries are counted apart from model failures.
- Scoring reports calorie error (mean, median, p90, absolute and signed), portion-weight error separately from macros, per-macro grams, failure rate, run-to-run spread, latency and cost per photo, plus a per-dish-type breakdown and the five worst misses with photos. It also checks that the gap between leaders exceeds run-to-run noise before a winner is declared.
- Thresholds, model list and run count live in `eval/config.json`; 24 unit tests cover the metrics and the dataset checks. Verified end to end against a stub provider.

### Tests, cleanup and documentation

- Added 112 integration tests against a real database, wired into CI on a service PostgreSQL: API routes (auth, ownership, validation, admin rights, cron secret), services (limits, locks, subscription, stats), bot flows (photo, voice, corrections, buttons, exhausted limit), retention, feed, timezones and scheduling, and provider failures. Each area gets the normal case, a failure and an edge, rather than a test per line.
- Added the first Mini App tests (16). Two pieces were extracted from components to make them testable: route resolution from URL and start param, and the "latest request wins" rule that was duplicated in two screens.
- Fixed three defects the tests exposed: a card-rendering failure reported "recognition failed" and refunded the attempt although the meal was already saved; challenge feasibility ignored the chosen value and was never checked on creation, so the API accepted 400 g of protein per day; the profile timezone was stored unvalidated, and any bogus value broke the diary permanently.
- Split `bot/bot.ts` (1127 lines) into composers per conversation area, with keyboards, meal card and shared texts extracted.
- Removed three smoke scripts and one that tested React by slicing a .tsx file with regular expressions: their scenarios are ordinary tests now.
- Added `docs/ARCHITECTURE.md` and `docs/TESTING.md`; refreshed the roadmap in `HANDOFF.md`.

### Food feed — data layer

- Added the data model for the shared food feed: opt-in publication per meal (`Meal.isPublic`), an auto-publish toggle (`Profile.feedOptIn`, off by default), per-viewer votes (`FeedVote`), reports (`FeedReport`) and denormalised like/vote counters.
- Added `services/feed.ts`: publish/unpublish, swipe queue (own, unpublished, hidden and already-voted meals excluded), idempotent voting, report-based hiding after two distinct reports, weekly leaderboard with shared Moscow week and tie-aware ranks, top meals of the week and per-user feed stats.
- Nothing is published without an explicit action: no existing meal becomes public by this change.
- Rules that decide ordering, week boundaries and ranks live in `src/feed.ts` and are unit-tested; the service itself is covered by integration tests against a real database.

### Retention: «можно?», actionable advice, evening reminder

- Added quick-check mode: a photo captioned «можно?» (or a question like «можно мне жареную картошку?») is recognised and checked against the user's diet without writing to the diary; a button logs it afterwards without a second model call.
- Meal cards end with one data-driven next step: calorie overshoot for the day, or the protein gap with diet-appropriate sources in the evening.
- Daily advice must end with a single verifiable action for today («Сегодня: …»).
- Evening reminder when the day is empty, with «ел как обычно» (logs the user's average day), «сейчас пришлю» and «не напоминать»; toggle in Settings. Sent only to active users, once per day, inside the existing daily cron.
- Vercel build now runs `prisma migrate deploy` before generating the client, so migrations ship with the deploy.

### Follow-up review fix

- Guarded challenge eligibility responses against rapid selection changes, cancellation and unmount; stale success/error responses cannot change the new selection.

### UX/UI audit, macro rings and purchase pause

- Restored individual protein/fat/carbohydrate progress rings with targets; simplified calorie hierarchy.
- Reduced bottom navigation to five destinations. Premium status lives under Profile; existing deep links show a purchase-pause placeholder.
- Disabled purchases server-side, including API invoice creation, legacy bot callbacks and old-invoice pre-checkout. Kept existing entitlements and completed-payment reconciliation.
- Added diary fetch race guards, explicit errors/retry, in-app recipe rename/delete forms, accessible meal-dialog keyboard behavior and safer destructive actions.
- Improved typography, target sizes, dark-mode text, food-name wrapping, onboarding progress and analytics missing-data explanation.
- Added purchase-pause regression tests and reproducible fixture-based mobile browser smoke tests at 320/390/560 px.
- Full audit, evidence scope and remaining issues: `docs/ux-ui-audit.md`.

## Previous Today UX pass (506fcd7)

### Changed

- Redesigned the Today hero card around the primary action: current calories, target, progress bar, and compact macro summary.
- Added a clear `Добавить еду` action that returns users to the Telegram chat to send a photo or text description.
- Added visual hierarchy for macro nutrients with color-coded, compact summary tiles.
- Preserved the existing Telegram theme variables, safe-area handling, and progress-ring component.

### Notes

- This is a focused first UX pass; navigation consolidation and custom bottom-sheet dialogs remain separate follow-up work.
