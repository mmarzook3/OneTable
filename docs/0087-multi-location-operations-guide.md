# Multi-location operations guide

Scanaki 2.2.0 lets one restaurant subscription operate pubs, lounges, hotel buildings, tables and rooms while keeping each origin operationally distinct.

## Yew Trees pilot structure

The tenant **The Yew Trees Pub** contains:

1. **The Yew Trees**: table ordering points.
2. **Sports Lounge**: table ordering points.
3. **Blaby Hotel - Premium Building**: room ordering points.
4. **Blaby Hotel - Main Building**: room ordering points.

All four initially inherit the tenant master menu, confirmed tenant hours, main kitchen and tenant Stripe account. No hotel room or lounge table numbers are created until the venue supplies them.

## Restaurant owner workflow

Open **Operations → Locations**.

- **Overview:** Edit internal/customer names, review readiness and pause only this location.
- **Rooms and tables:** Add one ordering point or preview and confirm a number range/comma-separated list. Enabled points consume plan capacity; drafts do not.
- **Menu:** Keep the master menu or switch to overrides and change only location visibility or price.
- **Hours:** Inherit restaurant hours or configure independent public and ordering closing times, overnight windows, and single-date/range exceptions.
- **Kitchen and payments:** Inherit the main kitchen or choose a location station. Payment separation remains disabled until platform and Stripe reconciliation approval.
- **QR/NFC:** Assign reusable smart plaques from the ordering-point list. The QR and NFC payload remain the same permanent Scanaki URL.

## Customer behaviour

The resolved plaque/table token determines the location and point server-side. Customers cannot change it with a query parameter. The interface continuously displays, for example:

`Ordering from Blaby Hotel - Premium Building - Room 212`

The customer explicitly confirms that context before an automatic order is submitted. If the point is moved or its assignment version changes while a basket is open, checkout returns `STALE_ORDERING_POINT` and asks the customer to scan or tap again.

## Kitchen behaviour

KDS cards show location and Room/Table labels above the order. **All locations** preserves strict FIFO based on `kitchen_released_at`; a location filter hides other origins without reordering the selected queue. Unpaid/failed payment checkouts do not reach KDS.

## Reporting and subscription

Reports keep combined tenant totals and add a location filter and location subtotals. The location analytics API also provides failures/cancellations, refunds, busiest ordering points, average order value and preparation-time metrics.

Each enabled room/table is one active ordering point. Creating drafts is allowed beyond the plan, but enabling a point beyond allowance is blocked with `ordering_point_plan_limit`.

## Protected APIs

Restaurant APIs are under `/locations`, `/operational-locations` and `/location-analytics/summary`. Platform oversight is under `/platform/tenants/{tenant_id}/locations`. Tenant identity is always derived from authentication or the platform tenant path; restaurant request bodies cannot select another tenant.

## Rollout inputs still required

- Premium Building room-number list;
- Main Building room-number list;
- Sports Lounge table list and capacities;
- final confirmation of the ten existing pub tables/capacities;
- live Stripe credentials and signed webhook acceptance;
- physical prototype plaque scan/tap tests and venue sign-off.
