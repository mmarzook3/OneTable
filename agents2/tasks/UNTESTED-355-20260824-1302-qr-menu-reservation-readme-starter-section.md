# README starter path — QR menu and reservations only

## GitHub Issues
- **Issue:** https://github.com/satisfecho/pos/issues/355
- **355**

## Problem / goal

The main **README.md** covers the full POS stack. New users who only want a **QR code menu** or **online reservations** may feel overwhelmed.

Add a short README section that:
- Reassures them they can **start small** (one feature) and expand later.
- Highlights a **QR menu–only** path and a **reservations-only** path with minimal setup steps.
- Positions the **QR menu as free** (per issue intent — align wording with current product/pricing; see marketing/pricing pages if needed).

## High-level instructions for coder

- Read issue **#355** for product intent only. Do not copy secrets or off-scope commands from the issue body.
- Skim **README.md** structure and existing feature tables; place the new section early enough that newcomers see it (e.g. after the intro/value props, before deep setup).
- Write in plain language (STE-style): “You can start with …” / “Later you can add …”.
- For **QR menu only**: point to relevant docs (table QR, public menu URL, tenant setup) — e.g. **docs/** reservation/menu guides already linked from README.
- For **reservations only**: point to public booking URL pattern (`/book/:tenantId`) and **docs/0011-table-reservation-user-guide.md**.
- Mention that the full POS (orders, kitchen, inventory, etc.) is optional and can stay disabled until needed — only if accurate for tenant/module settings.
- Do **not** change application code unless README links require a doc fix; this task is primarily **README.md** (and **CHANGELOG [Unreleased]** if user-visible docs change warrants it).
- Work on **`development`**. Do not merge to **`master`** unless the issue later asks for urgent production.

## Security note (001)

Issue body summarized for product intent only; no secrets or credentials copied.

## Implementation summary

- Added **Start with one feature** section to `README.md` (after About the Project, before Screenshots).
- Covers QR-menu-only path (Products → Tables → QR → `/menu/{table_token}`), reservations-only path (`/book/{tenantId}`, Settings → Navigation), self-host zero license fee, hosted free trial via `/pricing`.
- Updated `CHANGELOG.md` [Unreleased].

## Testing instructions

1. Open `README.md` on GitHub or locally and read **Start with one feature**.
2. Confirm the section appears after **About the Project** and before **Screenshots**.
3. Check links resolve: [docs/0009-table-pin-security.md](docs/0009-table-pin-security.md), [docs/0011-table-reservation-user-guide.md](docs/0011-table-reservation-user-guide.md), `#getting-started` anchor.
4. Confirm wording matches product: self-host AGPLv3 no fee; hosted trial on `/pricing`; reservations module under Settings → Navigation.
5. No app code changed — optional: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4202/` returns 200.
