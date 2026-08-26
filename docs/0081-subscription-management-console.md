# Scanaki subscription-management console

Platform operators use `/platform/subscriptions` to manage restaurant SaaS billing.

## Capabilities

- Search by restaurant, owner email, Stripe customer or subscription ID.
- Filter by status, plan, overdue state, failed payment or scheduled cancellation.
- Paginate up to 100 rows per request.
- View MRR, 30-day and recorded revenue, active/trial/past-due/suspended/canceling counts and 30-day churn.
- Inspect trial expiry, renewal date, latest invoice/payment health and Stripe identifiers.
- Open the customer directly in the appropriate live or test Stripe Dashboard.
- Synchronise Lite, Pro and Ultra prices and extra-table quantities to an existing Stripe subscription with explicit proration behaviour.
- Activate, suspend, schedule cancellation, cancel immediately or grandfather access.
- View sanitised Stripe invoices and PaymentIntents plus the immutable local audit timeline.

## Stripe events

The platform webhook at `/api/saas/webhook` must subscribe to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_action_required`

Webhook event IDs are unique in the audit ledger, so retry delivery does not duplicate revenue.

## Reporting notes

MRR is calculated from active Scanaki plans and approved extra-table quantities. Revenue comes from recorded `invoice.paid` webhook events. Churn is the distinct tenants canceled in the last 30 days divided by active tenants plus those cancellations. Metrics become historically complete from the deployment of the subscription-event migration; Stripe remains the authoritative source for older invoices.

Stripe plan changes use subscription item price/quantity updates with a selected proration policy. See the official Stripe documentation for [changing subscription prices](https://docs.stripe.com/billing/subscriptions/change-price), [updating subscriptions](https://docs.stripe.com/api/subscriptions/update), and [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).
