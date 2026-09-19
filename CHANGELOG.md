# Changelog

## Unreleased

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
