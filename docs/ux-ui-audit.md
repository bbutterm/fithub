# FitHub UX/UI audit and implemented corrections

## Scope and evidence

Repository baseline: `506fcd7`, clean `main` equal to origin before editing. Reviewed by current parent model (gpt-6-astra); backend implementation and independent diff review delegated to same-model subagents. No Claude sessions used.

Audited source: App/navigation, Today, Recipes, Challenges, Analytics, Settings, Onboarding, Subscription, MealDetail, Admin, shared CSS, rings, chart, swipe rows, bot/API payment entry points. Browser evidence: actual React/Vite rendering with **synthetic API fixtures**, not a production Telegram session or real user records. `scripts/ui-smoke.py` reproduces checks at 320, 390, 560 px; screenshots written to `/tmp/fithub-ui-qa`. No live payments, broadcasts or account deletions executed.

## Findings and decisions

| Priority | Area | Finding | Resolution |
|---|---|---|---|
| P0 | Premium | Hiding a purchase button would leave old chat callbacks, invoice API and already-issued invoices payable | Replaced pricing page with purchase-pause status; server rejects invoice requests; bot refuses new invoices; pre-checkout rejects old invoices; completed-payment reconciliation remains intact |
| P1 | Nutrition | Macro tiles removed useful progress-to-target information and contradicted user's preference | Restored three individual BJU rings with current/target values and units; calorie ring plus remaining/above-target text |
| P1 | Today | Duplicate calorie visualization (ring + numeric hero + bar), weak hierarchy | Removed redundant bar and repeated calorie total; larger calorie ring, clearly separated macro row |
| P1 | Today | Old date data retained during loading; out-of-order requests can overwrite selected day | Clear missing date cache; sequence guard for request results; error + retry instead of false empty state |
| P1 | Navigation | Six tabs are too cramped at phone width; inactive Premium takes prime space | Five tabs; Premium status under Profile; subscription deeplinks preserved; parent tab highlighted; scroll resets on navigation |
| P1 | Errors | Recipe fetch failure interpreted as no recipes, analytics failure as no data | Distinct error/retry states; stale analytics response ignored |
| P1 | Recipe editing | Native prompt/confirm and swallowed write errors | In-app rename form and explicit delete confirmation; write failure feedback and busy guards |
| P1 | Meal detail | Close button unavailable on load failure; no dialog keyboard behavior; delete errors unhandled | Persistent close button; labelled dialog, focus trap/restore, Escape, scroll lock; destructive confirmation and errors |
| P1 | Challenges | Failed eligibility check looks like infinite loading and still allows Start | Show error, exit failed selection; no Start until check completes; retry on initial fetch; quit failure surfaced |
| P2 | Typography | Low-contrast hints; tiny touch targets; clipped food names | Stronger hint color, 44px common actions, wrapped food names, keyboard focus outlines |
| P2 | Dark theme | Inherited body text can remain light-theme color under theme updates | Explicit root text token, verified in dark screenshot |
| P2 | Onboarding | Step number alone gives weak orientation | Three-segment step progress indicator |
| P2 | Analytics | Missing records visually resemble zero consumption | Recorded-days summary and explicit missing-data explanation |
| P2 | Accessibility | Rings unnamed; date arrows and food rows not keyboard-accessible | Ring accessible descriptions; named date controls; food rows Enter/Space; reduced-motion support |
| P2 | Settings | Save and destructive area touch visually | Added spacing; retained two-stage account-deletion confirmation; subscription status separated from purchase controls |

## Deliberately not changed / follow-up backlog

- This is a broad audit plus a bounded correction set, **not** a claim that every historical UX issue has been eliminated.
- Settings remains a long single-page form. Preserve existing manual-target recalculation behavior; model/API distinction between automatic and manual targets deserves a separate change with migration tests.
- Admin was source-audited only. Error copy conflates access/network failures; usage fetch failure appears empty; broadcast loops need explicit partial-completion reporting. Do not exercise live grants, revocation, broadcasts or destructive admin actions during visual QA.
- Native browser confirmation still used for deletion of diary meals and leaving challenges. Consider a reusable accessible confirmation sheet with transactional undo in a future iteration.
- Chart uses title attributes rather than fully touch-selectable data points. A table/details alternative would improve mobile accessibility.
- Request dates currently follow the device calendar. User/server timezone parity is a separate backend/frontend contract issue.
- Telegram native close behavior and authenticated production flows require a real Telegram launch. Browser smoke does not prove Telegram SDK behavior.
- Theme screenshots validate chosen fixtures, not all arbitrary Telegram theme palettes. No formal WCAG compliance claim.

## Verification protocol

1. `pnpm build` (both packages).
2. `pnpm --filter webapp typecheck` and `pnpm --filter webapp lint`.
3. `pnpm --filter bot-api test`: payment-pause tests include blocked API/legacy callbacks/checkouts and preserved successful-payment handling.
4. `git diff --check`.
5. Start local Vite at 127.0.0.1:5178; execute `scripts/ui-smoke.py` in a venv with Playwright/Chromium.
6. Inspect generated actual screenshots for Today, Premium, dark, Profile, meal dialog and small screens. Browser tests cover navigation, rename, deep links, error retry, absence of invoice requests, overflow and uncaught JS exceptions.
7. Independent diff review; fixes and repeat verification before commit. GitHub-associated noreply author only. Verify push, CI and hosting separately; do not equate green CI with a live release.
