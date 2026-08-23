# Platform operator portal – Documentation

This document describes the **platform operator portal**: login and SaaS oversight for Scanaki platform administrators. It is distinct from the **provider portal** (`/provider`) and **tenant staff** login (`/login`).

---

## 1. Overview

Platform operators can:

- **Log in** at `/platform/login` (scope `platform` on `/token`).
- View a **dashboard** at `/platform` with:
  - Total tenant (client) count
  - New tenant sign-ups in the last 30 days
  - Login activity (total count, last login time, last 24 hours / 7 days)
  - **All tenants** with owner contact email, product count, and links
  - Recent login events (who logged in, which tenant, scope)
- Open a **tenant detail** page at `/platform/tenants/{id}` with:
  - Owner and business contact (email, phone)
  - Activity stats (products, tables, users, orders, reservations)
  - **Staff accounts** (email + role) — whom to contact
  - Links to **public pages** for that tenant:
    - `/public-menu/{id}` — guest menu
    - `/book/{id}` — reservations / booking
    - `/waitlist/{id}` — waitlist
    - `/delivery/{id}` — Scanaki Delivery checkout
- Create a restaurant account at `/platform/restaurants/new`. The operator enters the restaurant name, owner name, and owner email. Scanaki creates the tenant and owner, then shows a one-time temporary password and password-creation link.

Platform-created owners are sent to `/onboarding` on their first sign-in. The resumable wizard covers account security, restaurant details, ordering hours, table/QR/NFC allocation, a starter menu, and a final readiness check. Existing tenants are marked complete by the migration and are not redirected.

Operator users live in the same `User` table with `role=platform_operator`, `tenant_id=NULL`, and `provider_id=NULL`.

---

## 2. URLs

| Purpose | URL |
|--------|-----|
| Operator login | `/platform/login` |
| Operator dashboard | `/platform` |
| Tenant detail | `/platform/tenants/{tenantId}` |
| Create restaurant | `/platform/restaurants/new` |
| Restaurant owner onboarding | `/onboarding` |
| Guest menu (review) | `/public-menu/{tenantId}` |
| Guest booking | `/book/{tenantId}` |
| Guest waitlist | `/waitlist/{tenantId}` |
| Guest delivery checkout | `/delivery/{tenantId}` |

---

## 3. Backend API

All endpoints require a JWT from login with `?scope=platform`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/token?scope=platform` | Operator login (email + password). |
| `GET` | `/platform/me` | Current operator profile. |
| `GET` | `/platform/metrics` | Aggregated metrics + recent tenants/logins. |
| `GET` | `/platform/tenants` | All tenants (up to 100) with owner contact and counts. |
| `POST` | `/platform/tenants` | Create a tenant and owner; return the one-time temporary credentials and password-creation URL. |
| `GET` | `/platform/tenants/{id}` | Tenant detail + staff contacts. |

Owner onboarding uses authenticated `/onboarding/status`, `/onboarding/password`, `/onboarding/business`, `/onboarding/operations`, `/onboarding/tables`, `/onboarding/progress`, and `/onboarding/complete` endpoints. Every read and write derives the tenant from the owner session.

Successful logins (all scopes) append a row to `login_event` for operator metrics.

---

## 4. Creating the first operator

Set credentials in **`config.env`** (never commit real passwords):

```env
PLATFORM_OPERATOR_EMAIL=ops@yourcompany.de
PLATFORM_OPERATOR_PASSWORD=choose-a-strong-password
```

Then run (with backend in Docker):

```bash
docker compose exec back python -m app.seeds.ensure_platform_operator
```

The seed is idempotent: re-running updates the password and ensures role/tenant fields are correct.

---

## 5. Security notes

- Operator endpoints expose **tenant owner/staff emails** and business contact fields to **platform operators only** — not to other tenants or public users.
- Customer/guest PII (reservation guest emails, order customer data) is not shown on the platform dashboard.
- Use a dedicated operator account; do not reuse tenant staff or provider credentials.
- Protect `PLATFORM_OPERATOR_PASSWORD` like any admin secret (deployment env / secrets manager).
- The readable temporary restaurant password is returned only in the create response. It is never logged or stored in plaintext. Operators must share it through a secure channel.
- Onboarding remains in browse-only mode when a menu or tenant Stripe credentials are missing. This prevents a restaurant accepting table orders before the launch essentials are ready.
