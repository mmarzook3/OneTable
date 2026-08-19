---
## Closing summary (TOP)

- **What happened:** Prospects needed dedicated public landing pages per product feature, not only summary cards on `/features`.
- **What was done:** Shipped 31 data-driven detail pages at `/features/{slug}` with hero, benefits, how-it-works, and register/demo CTAs; grid links from `/features`; `FEATURE_DETAIL.*` i18n in all locales; SEO and sitemap entries; honest preparation-only copy for invoicing/TSE.
- **What was tested:** `test:features` smoke PASS; i18n parity (3061 keys × 8 locales) PASS; manual checks on reservations, delivery, invoicing, and TSE PASS; sitemap has 31 feature URLs; front build clean after a transient hot-reload error.
- **Why closed:** All acceptance criteria passed (tester overall PASS).
- **Closed at (UTC):** 2026-08-19 14:09
---

# Create landing pages for features

## GitHub Issues
- **Issue:** https://github.com/satisfecho/pos/issues/347
- **347**

## Problem / goal

Prospects need **dedicated public landing pages per product feature** — not only the summary cards on `/features`. Each page should explain what the feature does, the benefit for restaurants and guests, and why it matters. Pages must work **without login**, match existing marketing styling (landing, `/features`, `/pricing`, `/about`), and stay honest about shipped vs preparation-only capabilities (VeriFactu/TSE, wallet passes, etc.).

## High-level instructions for coder

- Read issue #347 for product intent only. Do not copy secrets or credentials from the issue.
- Review current marketing surfaces: `front/src/app/features/features.component.ts` (category grid), `/pricing`, `/about`, shared `app-landing-site-footer`, `seo.service.ts`, and i18n keys under `FEATURES_PAGE.*` in `front/public/i18n/*.json`.
- **Scope first:** decide which features get their own URL in v1 (e.g. `/features/reservations`, `/features/delivery`, …). Prefer a data-driven list (slug + i18n keys) over one giant component per page. Link from each card on `/features` to its detail page.
- **Content per page (minimum):** hero title, short subtitle, 2–4 benefit bullets, optional “how it works” section, CTA to register or demo. Reuse the dark marketing visual language from `/features` and `/about`.
- **i18n:** add keys for all shipped locales; run `python3 scripts/check-i18n-locale-parity.py` after adding keys.
- **SEO:** register routes in `seo.service.ts` and sitemap logic if other marketing pages do.
- **Honesty:** align copy with `docs/` and ROADMAP — no “live/certified” claims for gated features (fiscal middleware, wallet passes, etc.).
- **Tests:** extend or add Puppeteer smoke (build on `npm run test:features --prefix front`) to open at least one feature detail URL and assert hero + nav; index in `docs/testing.md`.
- **Docs:** short note in `docs/README.md` Quick links if the route pattern is new for operators.
- Pass criteria: at least one navigable feature detail page from `/features`; all locales in sync; smoke passes; front build clean in `docker logs pos-front`.

## Security note (001)

Issue body summarized for product intent only; no secrets or credentials copied.

## Implementation notes

- Data-driven catalog: `front/src/app/features/feature-landings.ts` (31 slugs under `/features/{slug}`).
- Detail page: `front/src/app/features/feature-detail.component.ts` (hero, benefits, how-it-works, CTA).
- Grid cards on `/features` link to detail pages with “Learn more”.
- i18n: `FEATURE_DETAIL.*` in all locale files (seed via `python3 scripts/seed-feature-detail-i18n.py`).
- SEO: `SeoService.applyFeatureDetail()` + `sitemap.xml` entries for all detail URLs.
- Honest copy for invoicing/TSE (preparation/test, not certified live).

## Testing instructions

1. Sync and ensure stack is up (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4202/` → 200).
2. **Smoke:** `BASE_URL=http://127.0.0.1:4202 npm run test:features --prefix front` — must pass (grid + `/features/reservations` detail hero and benefits).
3. **Manual:** Open `http://127.0.0.1:4202/features` — each card should link to `/features/{slug}`; pick reservations, delivery, invoicing, tse and confirm hero, benefits, how-it-works, register/demo CTAs, no login required.
4. **i18n parity:** `python3 scripts/check-i18n-locale-parity.py` — all locales OK.
5. **Front build:** `docker logs --since 10m pos-front 2>&1 | grep -iE "error|Application bundle generation failed"` — no errors.
6. **SEO file:** `front/public/sitemap.xml` includes `https://satisfecho.de/features/reservations` (and other slugs).

---

## Test report

**Date/time (UTC):** 2026-08-19 14:07–14:11 UTC  
**Log window:** 2026-08-19 14:01–14:11 UTC (`docker logs --since 10m pos-front`)

**Environment:** `docker-compose.yml` + `docker-compose.dev.yml`, `BASE_URL=http://127.0.0.1:4202`, branch `development` @ `fd0678e3`

### What was tested

Per **Testing instructions** §1–6: stack health, Puppeteer smoke, manual browser checks on four feature detail pages, i18n parity, front build logs, sitemap entries.

### Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Stack responds 200 | **PASS** | `curl … http://127.0.0.1:4202/` → `200` |
| 2 | `npm run test:features` smoke | **PASS** | Grid hero, 4 categories, nav/CTA OK; `/features/reservations` detail hero "Online reservations", 3 benefit bullets |
| 3 | Manual detail pages (reservations, delivery, invoicing, tse) | **PASS** | 31 card links on `/features`; each detail has hero, "Why it matters", "How it works", register + demo CTAs; no login form; invoicing/TSE use preparation/test language (not certified live) |
| 4 | i18n locale parity | **PASS** | `check-i18n-locale-parity.py` — 3061 leaves, all 8 locales OK |
| 5 | Front build clean | **PASS** | One transient `TS2304 FeatureCategory` at 14:05:13 UTC during hot reload; bundle complete at 14:05:15+ (4 successful rebuilds); no errors after fix |
| 6 | Sitemap includes feature URLs | **PASS** | 31 `<loc>` entries under `/features/` including `reservations`, `satisfecho-delivery`, `invoicing`, `tse` |

**Overall: PASS**

### Product owner feedback

Feature landing pages deliver on issue #347: prospects can read dedicated copy per capability without logging in. The data-driven slug list (31 pages) scales well and links cleanly from the `/features` grid. Honest fiscal copy on invoicing/TSE matches the preparation-only stance in docs.

### URLs tested

1. http://127.0.0.1:4202/
2. http://127.0.0.1:4202/features
3. http://127.0.0.1:4202/features/reservations
4. http://127.0.0.1:4202/features/satisfecho-delivery
5. http://127.0.0.1:4202/features/invoicing
6. http://127.0.0.1:4202/features/tse

### Relevant log excerpts

```
# test:features (npm run test:features)
>>> RESULT: /features loads with hero, categories, nav/CTA, and /features/reservations detail page.

# i18n parity
PASS: all locales have every en.json leaf key

# pos-front build timeline (transient error resolved)
Application bundle generation failed. [11.037 seconds] - 2026-08-19T14:05:13.799Z
✘ [ERROR] TS2304: Cannot find name 'FeatureCategory'.
Application bundle generation complete. [1.933 seconds] - 2026-08-19T14:05:15.749Z
Application bundle generation complete. [2.305 seconds] - 2026-08-19T14:05:59.550Z
Page reload sent to client(s).
```
