# One Table — The Yue Tree Pub pilot runbook

This runbook provisions and validates the first One Table tenant. The Android wrapper/app is intentionally out of scope for this milestone; the kitchen uses the responsive `/kitchen` browser screen until that final packaging step.

## Provisioning

1. Copy `config.env.example` to the ignored `config.env` and set strong deployment secrets.
2. Add `YUE_TREE_OWNER_EMAIL`, `YUE_TREE_OWNER_PASSWORD`, `YUE_TREE_KITCHEN_EMAIL`, `YUE_TREE_KITCHEN_PASSWORD`, and the actual table count.
3. Start the stack and run:

   ```bash
   docker compose --env-file config.env -f docker-compose.yml -f docker-compose.dev.yml up -d
   docker compose --env-file config.env exec back python -m app.seeds.seed_yue_tree_pilot
   ```

The idempotent seed creates or repairs:

- The Yue Tree Pub tenant in GBP, English and Europe/London.
- Automatic ordering with Stripe prepayment, strict FIFO and a two-minute kitchen heartbeat requirement.
- A Main floor, a Kitchen station and `Table 1` through the configured table count.
- Ten clearly-labelled acceptance-test menu items.
- Owner and kitchen accounts when credentials are present.

The seed does not remove tables, rotate plaque tokens or overwrite an existing product. Replace the pilot products with the venue-approved menu, allergens, modifiers, prices and images before live use.

## Plaque production

In **Tables**, each permanent table owns a random stable token. Its QR code and NFC payload open the same canonical HTTPS menu URL. Use the tenant bulk PDF for prototype printing, then:

1. Print three prototype plaques with high-error-correction QR artwork.
2. On compatible Android Chrome, tap **Write NFC** and hold an NDEF-capable tag to the phone. Otherwise copy the NFC URL into a trusted tag-writing app.
3. Test both scan and tap on multiple phones and mark the plaque tested.
4. Embed a ferrite-backed/on-metal NFC tag if the finished plaque touches metal.
5. Do not permanently lock pilot tags until the production domain is final. Token rotation invalidates both old QR and NFC links and marks the plaque for reprint.

## Stripe activation

Use **Settings → One Table ordering** to select either tenant keys or Stripe Connect and save the publishable key, secret key, connected-account ID (Connect only), and webhook signing secret. Register this exact HTTPS endpoint in Stripe:

```text
https://<one-table-domain>/api/payments/stripe/webhook/<tenant-id>
```

Subscribe to `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.processing`, and `charge.refunded`. An unpaid checkout is never released to the kitchen; the signed webhook is the payment source of truth.

## Opening and closing

- Log the kitchen tablet into `/kitchen`. Its heartbeat opens automatic customer checkout once service hours allow it.
- Use Settings to pause/resume ordering for emergencies. Customers can still browse while ordering is unavailable.
- Keep the kitchen page visible, powered and connected. If its heartbeat disappears for two minutes, new checkouts stop automatically; existing paid orders remain visible.

## Acceptance checklist

- Owner and kitchen logins work and unrelated upstream modules are hidden.
- Each table link names the correct table; QR and NFC resolve to the same HTTPS menu.
- Off-hours, paused and kitchen-offline states permit browsing but block order creation.
- A customer confirms the table, submits a basket and is directed to Stripe.
- The unpaid order is absent from `/kitchen`.
- A valid signed successful-payment webhook releases exactly one paid order.
- Duplicate webhook delivery does not create another order or inventory movement.
- Failed/cancelled payment remains absent from `/kitchen`.
- Kitchen cards are oldest-paid-first and timers start at `kitchen_released_at`.
- Start, Ready and Delivered actions work on the touch screen and reconnect after a network interruption.
- Database backup and restore are tested before live payments.

## Still required from the venue before launch

- Confirm the exact table count/names, service hours, address and contact details.
- Approve the real menu, prices, allergen wording and availability.
- Supply Stripe/Connect credentials and complete Stripe account verification.
- Confirm the production domain, privacy notice, terms and refund/cancellation wording.
- Complete testing on real customer phones and the chosen Yue Tree kitchen tablet.

## VPS deployment and recovery

The production overlay serves the application through HAProxy on ports 80/443. Before running it, set these production values in ignored `config.env`:

```text
PUBLIC_APP_BASE_URL=https://<one-table-domain>
API_URL=/api
WS_URL=
CORS_ORIGINS=https://<one-table-domain>
SECRET_KEY=<32+ random characters>
REFRESH_SECRET_KEY=<different 32+ random characters>
YUE_TREE_*=<real pilot account values>
```

Install the combined TLS PEM under `certbot/haproxy-certs/`, export a 20+ character `ONETABLE_BACKUP_PASSPHRASE`, and run `scripts/deploy-onetable-vps.sh`. The deployment refuses local URLs, weak/default secrets, missing TLS, a failed pre-deploy backup, failed migrations, or an unhealthy result.

The core backup command is `ONETABLE_BACKUP_PASSPHRASE=... scripts/onetable-backup.sh`. It writes AES-256-CBC/PBKDF2 encrypted dumps and SHA-256 sidecars under `backups/onetable`, retaining 14 by default. After the first backup and after material database changes, run `ONETABLE_BACKUP_PASSPHRASE=... scripts/onetable-restore-check.sh <backup>`; it restores into a uniquely named temporary database, verifies the schema and Yue Tree tenant, and drops only that temporary database.

Schedule a daily encrypted backup and run `scripts/onetable-health-check.sh` at least every five minutes. The read-only reconciliation monitor fails when a prepayment order is marked successful but not released, released without successful payment, or remains incomplete for more than 15 minutes. Investigate Stripe and application logs before accepting more orders.

Do not put backup passphrases directly in cron on a live server. Use a root-owned wrapper that reads the secret from a mode `0600` file into the environment. Store a separate encrypted backup copy off the VPS and test recovery regularly.
