# Scanaki multi-location hotel ordering requirements

**Status:** Implemented in Scanaki 2.2.0

**Pilot customer:** The Yew Trees Pub / Blaby Hotel

**Purpose:** Extend one Scanaki restaurant tenant so it can operate multiple distinct service locations, room-service points and table-service points while initially sharing one menu, kitchen and Stripe account.

## 1. Business context

The Yew Trees operates within Blaby Hotel. Orders may originate from four operational locations:

1. **The Yew Trees**
2. **Sports Lounge**
3. **Premium Building**
4. **Main Building**

The locations must be operationally distinct even though they belong to the same Scanaki customer account.

- The Yew Trees and Sports Lounge use table numbers.
- Premium Building and Main Building use hotel room numbers.
- Every room and every table is one billable ordering point.
- All four locations initially share the same menu.
- All four locations initially inherit the same opening and ordering hours.
- All orders initially route to the same main kitchen.
- Every order must be paid online.
- All locations initially use the same Stripe account.
- Menu, hours, kitchen and Stripe configuration must be separable per location later.

## 2. Goals

The implementation must:

- represent multiple locations inside one tenant;
- distinguish hotel rooms from pub/lounge tables;
- keep QR and NFC ordering tied to an exact location and ordering point;
- show the location and room/table prominently throughout the customer journey;
- route all pilot orders to the existing main kitchen;
- support separate kitchen routing later without redesigning the data model;
- share one master menu while supporting per-location menu and price overrides;
- inherit tenant opening and ordering hours while supporting per-location overrides;
- use one Stripe account initially while supporting per-location payment configuration later;
- include every active room/table in the subscription allowance;
- provide combined and per-location reporting;
- preserve existing table tokens, orders and tenant isolation.

## 3. Non-goals for the initial release

The first release will not include:

- charging an order to a hotel room account;
- post-stay hotel billing or property-management-system integration;
- separate Scanaki subscriptions per location;
- separate legal owners for each location;
- separate Stripe accounts enabled in production;
- separate kitchens enabled in production;
- different location menus or hours configured at launch;
- delivery ordering;
- permanent NFC locking before physical pilot approval.

The architecture must permit the deferred capabilities without destructive migrations.

## 4. Terminology

### Tenant

The Scanaki customer account. The existing tenant remains **The Yew Trees Pub**.

### Location

An operational service area within a tenant, such as The Yew Trees, Sports Lounge, Premium Building or Main Building.

### Ordering point

A physical place from which a customer places an order. An ordering point is either:

- `table`
- `room`

The existing `Table` entity remains the canonical ordering-point record to minimise migration risk. It will gain location and type metadata.

### Service label

The customer-facing reference for an ordering point:

- `Table 4`
- `Room 212`

### Inherited configuration

A location uses the tenant-level value until an explicit location override is enabled.

## 5. Initial location configuration

| Internal location name | Customer display name | Ordering-point type | Initial menu | Initial kitchen | Initial payment account |
|---|---|---|---|---|---|
| The Yew Trees | The Yew Trees | Table | Tenant master menu | Main kitchen | Tenant Stripe account |
| Sports Lounge | Sports Lounge | Table | Tenant master menu | Main kitchen | Tenant Stripe account |
| Premium Building | Blaby Hotel - Premium Building | Room | Tenant master menu | Main kitchen | Tenant Stripe account |
| Main Building | Blaby Hotel - Main Building | Room | Tenant master menu | Main kitchen | Tenant Stripe account |

All four locations initially inherit the confirmed Yew Trees opening schedule:

| Day | Opening hours |
|---|---|
| Monday | 14:00-23:00 |
| Tuesday | 14:00-23:00 |
| Wednesday | 14:00-23:00 |
| Thursday | 14:00-23:00 |
| Friday | 14:00-00:00 |
| Saturday | 12:00-00:00 |
| Sunday | 12:00-22:30 |

Location ordering hours remain independently editable because kitchen service hours may differ from public opening hours.

## 6. Data model requirements

### 6.1 Tenant location

Add a tenant-scoped `TenantLocation` model with at least:

| Field | Requirement |
|---|---|
| `id` | Primary key |
| `tenant_id` | Required tenant foreign key and index |
| `name` | Internal operator name |
| `display_name` | Customer-facing name |
| `slug` | Tenant-unique stable slug |
| `location_type` | `pub`, `lounge`, `hotel_building` or future value |
| `is_active` | Controls whether new ordering points can accept orders |
| `sort_order` | Stable CRM/menu ordering |
| `menu_mode` | `inherit` or `override` |
| `hours_mode` | `inherit` or `override` |
| `kitchen_mode` | `inherit` or `override` |
| `payment_mode` | `inherit` or `override` |
| `opening_hours_override` | Nullable weekly JSON schedule |
| `ordering_hours_override` | Nullable weekly JSON schedule |
| `default_kitchen_station_id` | Nullable station override |
| `ordering_paused` | Per-location pause control |
| `ordering_pause_reason` | Customer-safe reason |
| `created_at` / `updated_at` | Audit timestamps |

Constraints:

- `name` must be unique within a tenant, case-insensitively.
- `slug` must be unique within a tenant.
- A location cannot reference another tenant's kitchen station.
- Tenant ownership must always come from the authenticated user or platform context, never an untrusted request field.

### 6.2 Ordering point extension

Extend the existing `Table` model with:

| Field | Requirement |
|---|---|
| `location_id` | Required `TenantLocation` foreign key after migration |
| `service_point_type` | `table` or `room` |
| `display_number` | Normalised table or room number, stored as text |
| `customer_label` | Optional override; default generated from type and number |
| `is_ordering_enabled` | Per-point emergency control |

Existing fields remain authoritative for token, floor, canvas, seat count, plaque lifecycle and active order state.

Rules:

- `Table.name` remains the staff-facing name.
- For `table`, the default customer label is `Table {display_number}`.
- For `room`, the default customer label is `Room {display_number}`.
- Room numbers are strings, not integers, to support values such as `101A`.
- An active ordering point counts against the subscription allowance.
- A disabled/archive-only point does not accept orders and must not consume allowance unless product policy later says otherwise.
- Ordering-point names/numbers must be unique inside a location, not across the entire tenant.

### 6.3 Location menu overrides

Add a location-product assignment/override model, for example `LocationMenuProduct`, with:

| Field | Requirement |
|---|---|
| `tenant_id` | Tenant isolation/index |
| `location_id` | Location foreign key |
| `tenant_product_id` | Existing tenant product foreign key |
| `enabled` | Nullable or explicit availability override |
| `price_cents_override` | Nullable location price |
| `category_override` | Optional future display grouping |
| `sort_order_override` | Optional location ordering |
| `available_from` / `available_until` | Optional location availability window |

Initial release behaviour:

- all locations use `menu_mode=inherit`;
- no product rows are duplicated;
- changes to the tenant master menu appear in every inheriting location;
- location overrides are evaluated only when `menu_mode=override`;
- order lines retain immutable product name, option and price snapshots.

Effective menu precedence:

1. tenant product exists and is active;
2. tenant product availability permits display;
3. location override may hide or enable the item;
4. location price override wins over tenant price;
5. promotions are evaluated using the effective location/channel context.

### 6.4 Location kitchen routing

Kitchen routing must support many locations pointing to one station.

Initial mapping:

```text
The Yew Trees orders -----------+
Sports Lounge orders -----------+
Premium Building room orders ---+--> Main kitchen
Main Building room orders ------+
```

Future mapping may be:

```text
The Yew Trees + Main Building --> Main kitchen
Premium Building -------------> Premium kitchen
Sports Lounge ----------------> Lounge kitchen
```

Routing precedence:

1. explicit product/station route when applicable;
2. location default kitchen station;
3. tenant default kitchen station;
4. existing safe fallback station.

Orders must snapshot the resolved location and station context so historical tickets remain intelligible after configuration changes.

### 6.5 Location payment routing

Add location payment inheritance without duplicating plaintext credentials.

Initial behaviour:

- `payment_mode=inherit` for all locations;
- all payments use the tenant's current Stripe configuration;
- online payment is mandatory;
- no room-account charge option is displayed.

Future override fields may include:

- Stripe Connect account ID;
- encrypted tenant-key reference or separately encrypted location keys;
- webhook/account readiness state;
- payment descriptor metadata.

Payment snapshots must store the Stripe account/Connect context used for the transaction. Changing a location's account must not change historical payment ownership.

### 6.6 Order snapshot

Extend `Order` with:

| Field | Requirement |
|---|---|
| `location_id` | Required for new table/room orders |
| `location_name_snapshot` | Customer-facing location at order time |
| `service_point_type_snapshot` | `table` or `room` |
| `service_point_label_snapshot` | `Table 4` or `Room 212` |
| `kitchen_station_id_snapshot` | Resolved station when released |
| `payment_account_snapshot` | Safe identifier only, never a secret |

The existing `table_id` remains the ordering-point foreign key for compatibility.

## 7. QR and NFC requirements

- Continue using permanent Scanaki plaque URLs: `https://scanaki.uk/p/{public-code}`.
- The public code resolves server-side to the assigned ordering point and its location.
- Do not expose a predictable room/table identifier as the only authorisation token.
- QR and NFC on the same plaque must resolve to the same permanent URL.
- Reassigning a plaque must update its location/point association and rotate affected hidden table tokens according to existing security rules.
- Existing plaques must remain valid after adding locations.
- The customer must not be able to change the room/table through a query-string edit.
- A missing, disabled or released assignment must show a customer-safe unavailable page.
- Analytics may record QR versus NFC entry source without storing unnecessary customer identity.

## 8. Customer ordering experience

### 8.1 Location context

The location and room/table context must be prominent and persistent.

Required examples:

- `Ordering from The Yew Trees - Table 4`
- `Ordering from Sports Lounge - Table 7`
- `Ordering from Blaby Hotel - Premium Building - Room 212`
- `Ordering from Blaby Hotel - Main Building - Room 104`

Display context in:

- menu header;
- basket drawer/page;
- table/room confirmation step;
- payment review;
- payment-success page;
- digital receipt/order status;
- customer order history.

The wording must use `Room` for hotel buildings and `Table` for pub/lounge locations.

### 8.2 Confirmation

Before checkout, require explicit confirmation:

- `I am ordering for Table 7 in the Sports Lounge`
- `I am ordering for Room 212 in Blaby Hotel - Premium Building`

The basket must be bound to one tenant, location and ordering point. A customer cannot mix products from different locations into one order.

If a plaque assignment changes while a basket is open, the server must reject stale checkout and require the customer to reopen the current plaque URL.

### 8.3 Availability messages

The effective customer availability is the combination of:

- tenant active state;
- tenant ordering pause;
- location active state;
- location ordering pause;
- ordering-point enabled state;
- effective location ordering hours;
- assigned kitchen heartbeat/readiness;
- product/location availability;
- payment configuration readiness.

Customers may browse outside ordering hours unless the location is hidden. Checkout must clearly explain why ordering is unavailable.

## 9. Kitchen display requirements

Every kitchen card must show:

- location display name;
- `Room` or `Table` label and number;
- order number;
- paid/released time;
- items, modifiers and notes;
- station route;
- FIFO timer and existing status controls.

Examples:

```text
Sports Lounge
Table 7
```

```text
Blaby Hotel - Premium Building
Room 212
```

Initial KDS behaviour:

- all four locations appear on the main kitchen display;
- FIFO remains based on paid kitchen-release time across all locations;
- cards may be filtered by location without changing queue order;
- sound, reconnect and heartbeat behaviour remains unchanged.

Future KDS behaviour:

- a station/tablet may subscribe only to assigned locations;
- reassignment must not hide already accepted orders from the original operational workflow;
- platform and restaurant owners can inspect routing configuration.

## 10. Opening and ordering hours

Locations inherit tenant hours by default.

Each location must expose editable controls for:

- `Use tenant opening hours`;
- `Use tenant ordering hours`;
- weekly opening override;
- weekly ordering override;
- date/range exceptions;
- closed-day override;
- location emergency pause.

Overnight windows such as `14:00-00:00` must be supported.

Effective precedence:

1. location date override;
2. location baseline override when enabled;
3. tenant date override;
4. tenant baseline schedule;
5. tenant default weekly schedule.

The CRM must clearly identify inherited values and provide `Reset to tenant default` without deleting tenant configuration.

## 11. Subscription and commercial rules

Each active room or table is one ordering point.

```text
The Yew Trees tables
+ Sports Lounge tables
+ Premium Building rooms
+ Main Building rooms
= total ordering points
```

Initial state:

- plan: Pro;
- included ordering points: 20;
- existing The Yew Trees tables: 10;
- currently available within plan: 10;
- actual hotel room and lounge table counts: TBP.

Rules:

- Creating or activating an ordering point beyond allowance must be blocked with a clear upgrade/extra-point action.
- Draft/inactive points may be prepared without accepting orders.
- Location creation itself does not consume allowance.
- Bulk room/table creation must preview the resulting plan usage before confirmation.
- CRM subscription reporting must show used and available ordering points.
- Existing extra-table billing becomes extra-ordering-point billing in operator/customer copy while retaining backward-compatible API/database identifiers where required.

## 12. CRM requirements

### 12.1 Platform CRM

Add a tenant location workspace reachable from restaurant details.

Required capabilities:

- list four locations and their readiness;
- create/edit/archive a location;
- edit internal and display names;
- see room/table counts and plan impact;
- view menu, hours, kitchen and payment inheritance state;
- see assigned/unassigned plaque counts;
- filter orders and revenue by location;
- inspect location-specific launch blockers.

### 12.2 Restaurant owner portal

Add a Locations section with:

- location cards/list;
- location identity/settings;
- room/table bulk creation;
- room/table rename, seat count and active state;
- menu inheritance and override editor;
- opening and ordering hours inheritance/override;
- kitchen station assignment;
- payment inheritance/readiness;
- pause/resume ordering;
- QR/NFC assignment workflow.

Controls must provide explanatory text suitable for non-technical hospitality owners.

### 12.3 Bulk ordering-point creation

Support examples:

- `Room 101` through `Room 120`;
- an explicit comma/newline list such as `101, 102, 104A, 201`;
- `Table 1` through `Table 12`.

Preview must show:

- generated labels;
- duplicates/conflicts;
- number of new ordering points;
- current allowance;
- post-create allowance usage.

## 13. Reporting requirements

All reports retain combined tenant totals and gain a location filter.

Required reporting dimensions:

- location;
- room/table;
- kitchen station;
- menu item;
- payment account;
- order channel;
- date/time.

Minimum CRM metrics:

- order count by location;
- gross sales by location;
- average order value by location;
- refunds/failures by location;
- busiest ordering points;
- kitchen preparation time by location;
- active ordering points versus allowance.

Historical reports must use order snapshots and remain stable after a location rename.

## 14. API requirements

Suggested protected APIs:

```text
GET    /locations
POST   /locations
GET    /locations/{location_id}
PATCH  /locations/{location_id}
POST   /locations/{location_id}/archive

GET    /locations/{location_id}/ordering-points
POST   /locations/{location_id}/ordering-points
POST   /locations/{location_id}/ordering-points/bulk
PATCH  /locations/{location_id}/ordering-points/{point_id}

GET    /locations/{location_id}/menu
PUT    /locations/{location_id}/menu-mode
PUT    /locations/{location_id}/menu/{tenant_product_id}

GET    /locations/{location_id}/hours
PUT    /locations/{location_id}/hours
POST   /locations/{location_id}/pause
POST   /locations/{location_id}/resume

GET    /locations/{location_id}/routing
PUT    /locations/{location_id}/kitchen-routing
PUT    /locations/{location_id}/payment-routing
```

Public menu and checkout responses must include a safe location context but never encrypted payment credentials or internal-only location data.

All mutations require tenant/role checks and audit events.

## 15. Permissions and audit requirements

Platform operator:

- create and archive locations;
- override plan-blocked setup where explicitly authorised;
- inspect all readiness/routing state;
- release plaques across tenants using existing controls.

Restaurant owner/admin:

- manage their own locations, points, menus, hours and routing;
- cannot access another tenant;
- cannot configure a Stripe account belonging to another tenant;
- cannot exceed the subscribed ordering-point allowance.

Kitchen staff:

- view location context;
- filter only permitted station/location views;
- cannot change configuration.

Audit at least:

- location create/update/archive;
- inheritance/override changes;
- ordering-point create/move/archive;
- menu price/availability override;
- kitchen/payment route change;
- pause/resume;
- plaque assignment/release;
- ordering-point token rotation.

## 16. Migration requirements

### 16.1 Existing Yew Trees data

Create the `The Yew Trees` location and migrate all ten existing tables to it.

- preserve table IDs;
- preserve table tokens;
- preserve order history;
- preserve floor/canvas positions;
- preserve active-order references;
- set `service_point_type=table`;
- derive display numbers from existing table names;
- do not rotate tokens solely because a location is added.

Create the remaining three locations with no ordering points until actual numbers are supplied.

### 16.2 Other tenants

For every existing tenant:

- create one default location from the tenant name;
- migrate existing tables to that location;
- set all location modes to inherit;
- preserve current behaviour and URLs;
- make `location_id` non-null only after idempotent backfill succeeds.

Migration must be retry-safe and safe under `--sync-idempotent`.

## 17. Backward compatibility

- Existing `/menu/{table_token}` URLs continue working.
- Existing `/p/{public-code}` plaques continue working.
- Existing API clients that use `table_id` continue working during deprecation.
- Existing tenant menus/hours/kitchen/payment settings behave as inherited defaults.
- Existing reports without a location filter return combined tenant totals.
- Existing table subscription limits are reworded but retain stored values.
- Location context is optional only for legacy historical orders; new orders require it.

## 18. Security requirements

- Enforce tenant ownership on every location query/mutation.
- Never trust `tenant_id` from a restaurant client body.
- Use opaque permanent plaque codes and existing hidden table tokens.
- Bind basket and checkout idempotency to tenant, location and ordering point.
- Reject stale/reassigned plaque sessions.
- Encrypt location-specific Stripe secrets if/when enabled.
- Verify Stripe webhook account context against the order payment snapshot.
- Keep room/table identifiers out of logs where not operationally required.
- Do not expose hotel guest identity in kitchen or reports beyond configured operational need.
- Preserve existing rate limits, signed webhooks and payment-before-kitchen release.

## 19. Performance and reliability

- Location resolution adds no more than one indexed database lookup to public plaque/menu load.
- Effective menu queries must avoid N+1 location-product lookups.
- Effective hours and kitchen/payment inheritance should be resolved server-side.
- Location data should be included in existing WebSocket order events.
- Kitchen reconnect must recover all paid unreconciled orders for assigned locations.
- Disabling a location must not delete or hide historical orders.
- Database backup and restore tests must include locations and ordering points.

## 20. Test requirements

### Backend

- tenant isolation for locations and ordering points;
- default-location migration for all existing tenants;
- preservation of table tokens and historical orders;
- room/table label generation;
- plan counting across all locations;
- bulk creation validation and allowance enforcement;
- inherited versus overridden menu resolution;
- location price/availability precedence;
- inherited versus overridden hours, including midnight close;
- location pause and tenant pause precedence;
- kitchen routing precedence;
- shared and future separate Stripe account routing;
- location/payment snapshots on orders;
- stale plaque reassignment rejection;
- reporting combined totals and location filters.

### Frontend

- CRM location list and readiness states;
- owner location editor helper text;
- bulk room/table preview and validation;
- responsive location/menu/hour screens;
- visible menu, basket and checkout location context;
- correct `Room` versus `Table` wording;
- KDS location/point display and filters;
- no document-level horizontal overflow;
- accessible drawer, forms, tables and focus states.

### End-to-end pilot

Test at least:

1. The Yew Trees table QR order;
2. Sports Lounge table QR order;
3. Premium Building room NFC order;
4. Main Building room QR order;
5. all four paid orders reach the main kitchen once;
6. KDS clearly distinguishes all origins;
7. FIFO is based on paid release time across locations;
8. failed/cancelled payment never releases an order;
9. per-location pause blocks only that location;
10. tenant pause blocks all locations;
11. menu/hour override affects only its location;
12. reporting totals match location subtotals;
13. plaque reassignment invalidates stale sessions;
14. plan allowance blocks excess active points.

## 21. Implementation phases

### Phase 1: Foundation

- tenant-location model and migration;
- ordering-point type/location extension;
- default location backfill;
- CRM location list/editor;
- plan counting across locations.

### Phase 2: Customer context

- plaque/menu location resolution;
- room/table customer wording;
- basket, checkout, receipt and order snapshots;
- public availability composition.

### Phase 3: Menu and hours

- menu inheritance and location overrides;
- location price/availability overrides;
- opening/ordering hour inheritance and overrides;
- date exceptions and pause control.

### Phase 4: Kitchen and reporting

- location-aware KDS cards/events;
- kitchen routing inheritance/override;
- KDS location filters;
- report location filters and metrics.

### Phase 5: Payment separation readiness

- explicit payment-routing inheritance model;
- safe payment account snapshots;
- location-specific Stripe/Connect override capability behind a disabled feature flag;
- reconciliation tests for shared and separate accounts.

### Phase 6: Yew Trees rollout

- create the four approved locations;
- migrate existing tables to The Yew Trees;
- add supplied Sports Lounge tables and hotel room numbers;
- assign plaque prototypes;
- run full venue acceptance;
- launch shared-menu/shared-kitchen/shared-Stripe mode.

## 22. Operational inputs still TBP

- Main Building room-number list;
- Premium Building room-number list;
- Sports Lounge table list and capacities;
- confirmation of the existing ten The Yew Trees tables/capacities;
- location-specific ordering hours if they later differ;
- location-specific menu differences if they later differ;
- future kitchen station allocation;
- future Stripe account allocation.

These inputs do not block implementing the reusable multi-location capability.

## 23. Acceptance criteria

The feature is complete when:

- one tenant contains the four approved locations;
- every active room/table belongs to exactly one location;
- existing ten pub table URLs and history remain valid;
- room QR/NFC opens a page naming the correct building and room;
- pub/lounge QR/NFC opens a page naming the correct location and table;
- location context persists through payment, receipt, kitchen and reporting;
- all four locations inherit one menu, hours, kitchen and Stripe account initially;
- each inherited setting can be overridden independently without data duplication;
- all pilot orders route to the main kitchen in strict FIFO order;
- combined reports equal the sum of location reports;
- the Pro allowance counts all active rooms and tables;
- excess ordering points are blocked or require purchased capacity;
- tenant isolation, payment idempotency and webhook tests pass;
- desktop/mobile customer, owner, CRM and KDS browser tests pass;
- production migration, backup, restore and health verification pass.

## 24. Definition of done

- Database migrations are idempotent and applied in production.
- Backend and frontend automated tests pass.
- Production Angular build has no compiler errors.
- Platform CRM and restaurant owner UI are documented.
- Existing tenants retain their previous behaviour.
- The Yew Trees pilot configuration is created without inventing TBP room/table numbers.
- Three prototype QR/NFC plaques are tested at the venue before mass production.
- Stripe live payment acceptance is completed after credentials are supplied.
- Venue signs off location names, service points, menus, hours, legal wording and kitchen workflow.

## 25. Implementation result

Scanaki 2.2.0 implements the reusable multi-location architecture and all software acceptance paths described above:

- tenant locations and location-aware ordering points with idempotent default backfill;
- preserved legacy table IDs, tokens, plaques and historical orders;
- Room/Table customer labels and immutable order, kitchen and payment snapshots;
- master-menu inheritance plus location availability and price overrides;
- separate location opening/ordering schedules, overnight hours and date/range exceptions;
- location pause, kitchen routing and disabled-by-default payment-account override support;
- owner and platform location workspaces with bulk preview and subscription enforcement;
- customer context through basket, checkout, payment result, status and history;
- paid-release FIFO KDS origin labels and location filters;
- combined/location reporting and active ordering-point allowance metrics;
- tenant-isolation, stale-assignment, migration-retry, mobile/desktop and regression coverage.

The four approved Yew Trees locations are provisioned without inventing operational inputs that remain TBP. Stripe live payment acceptance and physical QR/NFC plaque sign-off remain venue rollout activities, not missing platform functionality. See [0087-multi-location-operations-guide.md](0087-multi-location-operations-guide.md).
