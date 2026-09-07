# Phase 1 login regression

The original transaction run timed out inside a broad staff-login stage without
recording the failing wait. No token POST appeared in the checked backend logs.
The same synthetic credentials subsequently logged in successfully. A persistent
application or credential defect was not reproduced.

The shared staff-login helper now waits for a ready Angular form, valid inputs
and enabled submit control, then waits explicitly for the token response before
checking navigation and the authenticated server-side tenant/user identity.
Failures identify the stage and HTTP rejection code without credentials or
response bodies. The dedicated login smoke can save cleared-input screenshots
under an explicitly supplied repository tmp directory.

Verification on 2026-09-07:

- Two fresh browser contexts passed locally against http://haproxy:4202.
- Two fresh contexts passed against https://scanaki.uk.
- The VPS synthetic login fixture is tenant 21. No order, payment or refund was
  created by this regression test. Test scripts and fixture tooling were copied
  to /opt/scanaki/app for the live check; no production application rebuild was
  required for these test-only changes.

Run scripts/test-staff-login.mjs in the frontend container with BASE_URL,
PUPPETEER_EXECUTABLE_PATH and stdin JSON containing email, password and tenantId.
Never pass credentials in command arguments or commit them. Each run creates two
fresh browser sessions and verifies the authenticated identity.

This closes the login-test blocker, not Phase 1. Full transaction, webhook,
refund, permissions and receipt/report acceptance must still pass before phase
closure. No claim is made that login failures can never recur.
