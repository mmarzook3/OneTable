# One Table restaurant onboarding

One Table staff can provision a restaurant from the platform portal without command-line or database work. The restaurant owner then completes a short, resumable first-login wizard.

## Operator flow

1. Sign in at `/platform/login`.
2. Open `/platform/restaurants/new`.
3. Enter the restaurant name, owner name, and owner email.
4. Save the returned sign-in email and one-time temporary password. A password-creation URL is also returned when `PUBLIC_APP_BASE_URL` is configured.
5. Share the credentials with the owner through a secure channel.

`POST /platform/tenants` is restricted to platform operators. It creates:

- a tenant with UK defaults (`GBP`, `Europe/London`, English, `GB`);
- an owner user with a hashed temporary password;
- a single-use password-reset token;
- `onboarding_status=not_started` and safe `menu_only` ordering.

The readable temporary password appears only in the API response and operator result screen. It is not stored in the database or logs.

## Owner flow

After signing in, an owner whose tenant onboarding is incomplete is redirected to `/onboarding`. Progress is stored after each section:

1. Replace the temporary password, unless the owner already used the password-creation link.
2. Confirm restaurant and contact details.
3. Select normal ordering days and hours.
4. Create an area and all tables in one action. After setup, **Tables** guides the owner to scan and assign a reusable OneTable QR/NFC plaque to each physical table.
5. Add optional starter menu items.
6. Review readiness and finish.

The wizard is idempotent where it creates physical tables: retrying after a saved response does not add a duplicate set. The owner can close the browser and resume at the last saved section.

Plaques are deliberately separate from tables. The OneTable team generates permanent plaque inventory at `/platform/smart-plaques`; restaurant owners then use **Assign QR & NFC** on a table. The printed `/p/{code}` address remains unchanged when the plaque moves. See `0079-reusable-smart-plaques.md`.

## Safe launch behaviour

Completing the wizard does not silently expose an incomplete restaurant to paid ordering:

- menu plus tenant Stripe keys configured: automatic ordering and immediate payment can be enabled;
- menu or Stripe missing: table links stay in `menu_only` browse mode;
- the dashboard explains that the owner must complete Products and Stripe Settings before enabling automatic ordering.

Existing tenants receive the migration default `onboarding_status=completed`, so deployment does not interrupt current staff accounts.

## Verification

Backend coverage is in `back/tests/test_restaurant_onboarding.py`. The browser smoke is `front/scripts/test-restaurant-onboarding.mjs` and exercises platform creation, owner login, every wizard section, completion, and the dashboard redirect.
