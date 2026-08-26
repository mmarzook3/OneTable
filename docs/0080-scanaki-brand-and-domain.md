# Scanaki brand and domain

The hosted product name is **Scanaki**, a Fixaki product. Its canonical public origin is:

```text
https://scanaki.uk
```

Customer-visible application copy, legal pages, metadata, email defaults, QR/NFC artwork and operational documentation use Scanaki. Restaurant-specific names and branding still override the product identity where appropriate on guest menus.

## Production configuration

Use the following values in the production secret environment:

```text
PUBLIC_APP_BASE_URL=https://scanaki.uk
CORS_ORIGINS=https://scanaki.uk
PUBLIC_TERMS_OF_SERVICE_URL=https://scanaki.uk/terms
PUBLIC_PRIVACY_POLICY_URL=https://scanaki.uk/privacy
EMAIL_FROM=noreply@scanaki.uk
EMAIL_FROM_NAME=Scanaki
```

Before switching live traffic:

1. Point the `scanaki.uk` DNS records at the production ingress.
2. Install a TLS certificate covering `scanaki.uk`.
3. Register `https://scanaki.uk` with Stripe, Revolut, OAuth and email-link providers where used.
4. Update Stripe guest-order webhooks to the `scanaki.uk` endpoint.
5. Run the landing, API health, payment and smart-plaque smokes against the new origin.
6. Generate physical QR/NFC plaques only after the final domain and TLS configuration are working.
7. Rebuild and republish each separately bundled tenant microsite under `front/sites/` before retiring the previous platform origin; keep an HTTPS redirect during that transition.

## Compatibility identifiers

Some technical names intentionally retain the previous project identifier:

- `ONETABLE_*` backup and health-check environment variables;
- `onetable-*.sh` operations scripts;
- `onetable_ordering.py` and existing migration filenames;
- `satisfecho_delivery` database values, API paths and TypeScript/Python symbols;
- payment idempotency keys and credential-encryption salts;
- the current GitHub source URL `mmarzook3/OneTable`.
- previously compiled tenant microsite bundles until each independent site is rebuilt and republished.

These values are not displayed as the product brand. Changing them would require data migrations, compatibility aliases or an external GitHub repository rename. They can be migrated separately after the Scanaki production launch.
