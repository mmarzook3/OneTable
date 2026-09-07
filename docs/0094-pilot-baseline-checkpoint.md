# Phase 0 browser baseline checkpoint

The standalone test image includes Chromium and locked npm dependencies. It does not change the application frontend image.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.test.yml build browser-test
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.test.yml run --rm browser-test
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.test.yml run --rm -e BASE_URL=https://scanaki.uk browser-test
```

Both local and live runs passed on 2026-09-07. Coverage: liveness, readiness including database and Redis, landing brand, mobile navigation, footer scrolling, version, demo card and Swagger. This public baseline does not establish authenticated transaction acceptance or clean browser console output.

## Remaining Phase 0 gaps

- Production emits CSP violations for Google Fonts from fonts.gstatic.com. The current landing smoke logs these without failing.
- Production master is unprotected. Controlled promotion and CI test gating remain to be implemented.
- Current production backup age, restore result, disk usage and alert delivery have not been verified in this checkpoint.
- A complete rollback procedure remains outstanding.
- Alert recipient is confirmed as alerts@scanaki.uk. The Google group exists and accepts external posts; outgoing SMTP and actual delivery still need verification.
- Local development now tracks scanaki/development. Legacy promotion scripts still need alignment before unattended use.

Phase 0 remains incomplete. Keep the scheduler paused until the outstanding checks are resolved; do not treat the baseline's exit code as whole-phase acceptance.
