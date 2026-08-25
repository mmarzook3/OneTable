# Platform-managed pricing and offers

Platform operators manage Scanaki subscription tiers at `/platform/pricing`. The public `/pricing` page, signup paywall and Stripe Checkout all read the active database revision from `/api/saas/config`; publishing no longer requires changing VPS environment variables or rebuilding the frontend.

## Tier controls

Each Lite, Pro and Ultra revision stores:

- name, description, visibility and featured status;
- regular monthly price and optional lower offer price;
- optional offer badge, start and end timestamps;
- included tables, extra-table monthly price and trial duration;
- Stripe Product, regular Price, offer Price and extra-table Price identifiers.

The public API returns only display fields and Checkout availability. Stripe identifiers remain restricted to authenticated platform operators.

## Publishing and contract safety

Every publication creates a new immutable `saas_plan_pricing` revision and deactivates the previous revision. Before activation, tenants without a contract snapshot are frozen to the previous effective price, extra-table unit price and included-table allowance.

Operators choose one existing-customer policy:

1. `new_customers_only` — existing contracts remain unchanged; this is the default.
2. `next_renewal` — Stripe subscription items switch with `proration_behavior=none`, so no mid-cycle proration is created.
3. `immediate` — Stripe subscription items switch with `proration_behavior=always_invoice` and pending-payment protection.

Migration successes and per-tenant failures are recorded in `saas_pricing_event`. MRR uses each tenant's contract snapshot rather than today's landing-page price.

## Stripe price lifecycle

Stripe Price amounts are immutable. When **Create replacement Stripe prices automatically** is selected, Scanaki reuses or creates the tier Product, creates new recurring Prices for changed amounts, and saves the returned identifiers on the new pricing revision. Old Stripe Prices remain available for grandfathered contracts and historical invoices.

If Stripe is not configured, operators can still publish public pricing. Checkout remains unavailable for a tier until valid `price_…` identifiers or automatic Price creation are configured.

References: [manage Stripe prices](https://docs.stripe.com/products-prices/manage-prices), [change subscription prices](https://docs.stripe.com/billing/subscriptions/change-price).
