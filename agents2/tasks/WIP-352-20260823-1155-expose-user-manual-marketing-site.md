# Expose the user manual and link it from the marketing site

## Status
- **WIP (2026-08-23):** Publishing `docs/manual-usuario/` to `front/public/manual-usuario/` and adding marketing links per issue #352.

## GitHub Issues
- **Issue:** https://github.com/satisfecho/pos/issues/352
- **352**

## Problem / goal

The complete user manual lives in `docs/manual-usuario/index.html` but is not reachable from any public URL. Publish it with the frontend static assets and link it from marketing entry points (footer, about).

## High-level instructions for coder

- Serve manual at **`/manual-usuario/`** (copy tree into `front/public/manual-usuario/` including `img/`).
- Add translated **User manual** link in **`landing-site-footer`**, **`/about`**, and ensure **`/features`** footer includes it (shared footer).
- i18n: translate link labels in all shipped locales; manual body stays Spanish for this slice (English manual translation is follow-up).
- Smoke: `curl` returns 200 for `/manual-usuario/`; landing/features/about show the link.

## Implementation notes

- Copied `docs/manual-usuario/` (HTML + `img/`) → `front/public/manual-usuario/` — served at **`/manual-usuario/`**.
- **`landing-site-footer`**: User manual link in Support group (`data-testid="landing-user-manual"`).
- **`about-page`**: New manual section with link (`data-testid="about-user-manual"`).
- **`/features`** footer uses shared `landing-site-footer` (link included).
- i18n: `LANDING.USER_MANUAL`, `ABOUT_PAGE.MANUAL_TITLE`, `ABOUT_PAGE.MANUAL_BODY` in all shipped locales. Manual body remains Spanish (source); English manual translation is follow-up per issue discussion.

## Testing instructions

### What to verify
- `/manual-usuario/` returns 200 and shows the manual (images load from `/manual-usuario/img/`).
- Footer on `/`, `/features`, `/pricing`, `/about` shows translated **User manual** link.
- `/about` has a manual section with working link.

### How to test
```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4202/manual-usuario/
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4202/manual-usuario/img/landing.png
cd front && BASE_URL=http://127.0.0.1:4202 npm run test:landing-version
```
Browser: open `/about` and `/features`, confirm footer link; open `/manual-usuario/`.

### Pass–fail criteria
- **PASS:** Manual URL and sample image return 200; marketing pages show link; no new Angular build errors in `docker logs pos-front`.
- **FAIL:** 404 on manual paths; missing link; broken images; compile errors.
