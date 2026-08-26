# Platform settings and SMTP

Platform operators manage Scanaki-wide identity, legal links and outbound platform email at `/platform/settings`. These settings are separate from restaurant-specific settings and SMTP credentials.

## Company and legal identity

The console stores:

- legal company name;
- support and contact email;
- phone, registered address and website;
- company and VAT numbers;
- Terms and Privacy URLs.

The public-safe projection is `GET /api/platform/public-settings`. It contains only company, contact and legal fields. Marketing footers consume it for the operator name, support links and legal destinations. `GET /api/public/legal-urls` also uses the platform URLs with the existing VPS/built-in fallback.

## SMTP configuration

The protected console/API stores:

- SMTP host and port;
- TLS/STARTTLS selection;
- username;
- sender email and sender name;
- encrypted SMTP password.

The password is encrypted with a key derived from the application secret before database storage. Reads return only a configured flag and a mask; neither ciphertext nor plaintext is returned. Leaving the password field blank preserves the saved password. Selecting the removal control clears the database secret.

Until an encrypted database password is saved, Scanaki continues using the existing VPS SMTP environment configuration. Replacing those environment-managed connection fields requires entering a password in the same save, preventing a partially configured sender.

Restaurant SMTP remains independent. A restaurant with its own SMTP credentials continues using them; otherwise transactional email falls back to the platform-managed sender.

## Connection test

`POST /api/platform/settings/test-smtp` sends a real `Scanaki SMTP test` message to the operator-provided recipient, or the configured contact/support/sender address. The console records:

- last tested timestamp;
- verified or failed state;
- a sanitised status message.

Authentication and connection failures never return stored credentials or raw server exceptions.

## Operator usernames

Platform login accepts a case-insensitive username or email-form identifier. Platform operators remain isolated from tenant and provider accounts and retain the same protected role checks.

The Platform Settings security section lets the signed-in operator change their password after confirming the current password. A successful change increments the token version, revokes existing sessions and requires a fresh login.
