---
## Closing summary (TOP)

- **What happened:** Feature landing pages from #347 needed real translations instead of English placeholders in non-en locales.
- **What was done:** Coder translated FEATURES_PAGE and FEATURE_DETAIL (31 slugs) across de, es, fr, ca, zh-CN, hi, ur, bg; templates already used ngx-translate.
- **What was tested:** i18n parity PASS; features Puppeteer PASS; de/es/zh-CN UI and detail pages PASS; front build clean; overall PASS.
- **Why closed:** All verification criteria passed. Promote development → master remains for the promote/committer step (issue asked production after testing).
- **Closed at (UTC):** 2026-08-20 05:25
---

# Feature detail pages need proper translation

## GitHub Issues
- **Issue:** https://github.com/satisfecho/pos/issues/348
- **348**
- Related closed work: https://github.com/satisfecho/pos/issues/347 (`CLOSED-347-20260819-1401-create-landing-pages-for-features.md`)

## Problem / goal

Public feature landing pages from **#347** (`/features` grid and `/features/{slug}` detail) still read as English-first. Locale files may have matching **keys** (parity), but many `FEATURE_DETAIL.*` / related marketing strings are English copies, not real translations. Ship proper copy for every supported locale, then promote to production after tests pass (issue asks for production after testing).

## High-level instructions for coder

- Read issue **#348** for product intent only. Do not copy secrets or off-scope commands from the issue body.
- Start from shipped **#347** surfaces: `front/src/app/features/feature-landings.ts`, `feature-detail.component.*`, `features.component.*`, and i18n under `FEATURE_DETAIL.*` / `FEATURES_PAGE.*` in `front/public/i18n/*.json`.
- Follow **`.cursor/rules/angular-ngx-translate.mdc`** and **`docs/0012-translation-implementation.md`**: no raw English literals in templates for user-visible copy; use `translate` pipe / `TranslateService`.
- **Translate for real:** update every shipped locale (`en`, `de`, `es`, `fr`, `ca`, `zh-CN`, `hi`, and any other file already in `front/public/i18n/`) with natural translations — do not leave English text as placeholders in non-`en` files.
- Keep **honest** preparation/test wording for gated features (invoicing, TSE, etc.) consistent across languages (same claims as English, not stronger).
- After edits: `python3 scripts/check-i18n-locale-parity.py` must pass.
- Smoke: `BASE_URL=http://127.0.0.1:4202 npm run test:features --prefix front`; manually switch locale (language picker) on `/features` and at least two detail slugs (e.g. reservations, delivery) and confirm UI is not English-only.
- Confirm front build clean: `docker logs --since 10m pos-front` has no TS / bundle failures.
- **Branch / release:** work on **`development`**. After tester PASS, promote **`development` → `master`** and push so production picks it up (issue requests production after testing; allowed as explicit production ask).

## Security note (001)

Issue body summarized for product intent only; no secrets or credentials copied.

## Implementation notes (coder)

- Updated `FEATURES_PAGE` and `FEATURE_DETAIL` (all 31 detail slugs) in every shipped locale under `front/public/i18n/`: `de`, `es`, `fr`, `ca`, `zh-CN`, `hi`, `ur`, `bg`.
- Brand product name **Satisfecho Delivery** and a few brand/tech labels (e.g. Open Source where usual) stay as English intentionally.
- Compliance copy for VeriFactu / TSE kept honest (preparation / not certified until credentials verified), matching English strength.
- Templates already use `translate` pipe; no component changes required.
- Document/SEO titles remain English marketing SEO strings from `feature-landings.ts` (by design for crawlers).

## Testing instructions

1. Sync / ensure app up on `http://127.0.0.1:4202`.
2. Run: `python3 scripts/check-i18n-locale-parity.py` — expect PASS.
3. Run: `BASE_URL=http://127.0.0.1:4202 npm run test:features --prefix front` — expect PASS.
4. Open `/features`. Use the language picker for at least **de**, **es**, and one of **zh-CN** / **hi** / **bg**. Confirm hero title and card copy are not English.
5. Open `/features/reservations` and `/features/satisfecho-delivery` in **de** and **es**. Confirm benefits / how-it-works sections are translated.
6. Spot-check invoicing or TSE detail: wording must not claim certification beyond English.
7. `docker logs --since 10m pos-front` — no Angular/TS bundle failures.
8. After tester PASS: promote `development` → `master` and push (issue asks for production).


## Test report

1. **Date/time (UTC):** 2026-08-20 05:23:01 start → 05:24:49 end. Log window: `pos-front` last ~10m.
2. **Environment:** `docker-compose.yml` + `docker-compose.dev.yml`; `BASE_URL=http://127.0.0.1:4202`; branch `development` (synced before test).
3. **What was tested:** i18n leaf parity; features Puppeteer smoke; language picker on `/features` (de, es, zh-CN); detail pages reservations + Satisfecho Delivery (de, es); invoicing (de) + TSE (es) honesty; front build logs.
4. **Results:**
   - App up on 4202 (`/` and `/features` HTTP 200): **PASS**
   - `python3 scripts/check-i18n-locale-parity.py`: **PASS** (bg/ca/de/es/fr/hi/ur/zh-CN — missing=0 extra=0)
   - `npm run test:features`: **PASS** (hero, categories, nav/CTA, `/features/reservations` detail)
   - Locale picker `/features` not English-only: **PASS** — de hero `Alles, was Satisfecho bietet`; es `Todo lo que ofrece Satisfecho`; zh-CN `Satisfecho 提供的一切`
   - `/features/reservations` de/es benefits + how-it-works: **PASS** (e.g. de `Online-Reservierungen` / es `Reservas online` with translated bullets)
   - `/features/satisfecho-delivery` de/es: **PASS** (brand title stays `Satisfecho Delivery`; body translated)
   - Invoicing/TSE honesty vs English: **PASS** — de invoicing keeps VeriFactu test/preparation and “nicht als zertifiziert vermarktet”; es TSE says preparation / no BSI claim until credentials verified
   - `docker logs --since 10m pos-front`: **PASS** — bundle complete; only existing NG8107 warnings; no TS/bundle failures
   - Promote `development` → `master` (instruction 8): **DEFERRED** — tester role does not promote; issue #348 still needs promote after CLOSED (explicit production ask)
5. **Overall:** **PASS** (all verification criteria). Promote to production remains a follow-up for promote/committer step.
6. **Product owner feedback:** Feature marketing pages now show real copy in shipped locales, not English placeholders. SEO document titles stay English by design. After promote to `master`, re-check on production if needed.
7. **URLs tested:**
   1. http://127.0.0.1:4202/features (en, then de, es, zh-CN via picker)
   2. http://127.0.0.1:4202/features/reservations (de, es)
   3. http://127.0.0.1:4202/features/satisfecho-delivery (de, es)
   4. http://127.0.0.1:4202/features/invoicing (de)
   5. http://127.0.0.1:4202/features/tse (es)
8. **Relevant log excerpts:**
```
Application bundle generation complete. [0.042 seconds] - 2026-08-20T05:21:46.294Z
Page reload sent to client(s).
```
No `TS`/`NG8002`/bundle-failed lines in the 10m window. Features smoke: `>>> RESULT: /features loads with hero, categories, nav/CTA, and /features/reservations detail page.`
