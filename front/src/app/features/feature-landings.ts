/** Public feature landing slugs and i18n keys (shared by /features grid and /features/:slug). */
export interface FeatureLanding {
  slug: string;
  titleKey: string;
  descKey: string;
  /** English SEO title/description for crawlers (marketing pages use fixed meta). */
  seoTitle: string;
  seoDescription: string;
}

export interface FeatureCategory {
  id: string;
  titleKey: string;
  items: FeatureLanding[];
}

const item = (
  slug: string,
  key: string,
  seoTitle: string,
  seoDescription: string,
): FeatureLanding => ({
  slug,
  titleKey: `FEATURES_PAGE.FEAT_${key}_TITLE`,
  descKey: `FEATURES_PAGE.FEAT_${key}_DESC`,
  seoTitle,
  seoDescription,
});

/** Detail copy lives under FEATURE_DETAIL.ITEMS.<slug> in i18n files. */
export const FEATURE_CATEGORIES: FeatureCategory[] = [
  {
    id: 'guest',
    titleKey: 'FEATURES_PAGE.CAT_GUEST',
    items: [
      item(
        'qr-menu',
        'QR_MENU',
        'QR digital menu — One Table',
        'Mobile QR menus for restaurants — no app install. Guests scan, browse dishes, and order from their phone.',
      ),
      item(
        'table-ordering',
        'TABLE_ORDER',
        'Table ordering — One Table',
        'Let guests order from their table with a QR or table code. Orders go straight to kitchen and bar displays.',
      ),
      item(
        'takeaway',
        'TAKEAWAY',
        'Take away & delivery ordering — One Table',
        'Dedicated take-away flow for collection or home delivery — one menu, multiple channels.',
      ),
      item(
        'reservations',
        'RESERVATIONS',
        'Online reservations — One Table',
        'Public booking pages with availability, confirmations, and optional prepayment for your restaurant.',
      ),
      item(
        'waitlist',
        'WAITLIST',
        'Waiting list — One Table',
        'Queue guests when tables are full. Collect party size and phone, then notify when a table is ready.',
      ),
      item(
        'satisfecho-delivery',
        'SATISFECHO_DELIVERY',
        'One Table Delivery — One Table',
        'Online delivery with address, zone fees, payment, and order tracking for guests, staff, and couriers.',
      ),
      item(
        'payments',
        'PAYMENTS',
        'Online payments — One Table',
        'Accept card payments at the table or when booking via Stripe and Revolut Checkout.',
      ),
      item(
        'order-comments',
        'ORDER_COMMENTS',
        'Order comments — One Table',
        'Guests add notes per item or for the whole order — visible on kitchen, bar, and staff order cards.',
      ),
      item(
        'guest-feedback',
        'GUEST_FEEDBACK',
        'Guest feedback — One Table',
        'Collect ratings and comments after visits to improve service and spot issues early.',
      ),
    ],
  },
  {
    id: 'operations',
    titleKey: 'FEATURES_PAGE.CAT_OPERATIONS',
    items: [
      item(
        'kitchen-display',
        'KITCHEN',
        'Kitchen display — One Table',
        'Full-screen kitchen view filtered to main courses and food items — clear tickets, faster service.',
      ),
      item(
        'bar-display',
        'BAR',
        'Bar display — One Table',
        'Separate bar screen for beverages and drinks-only tickets — keep bar and kitchen in sync.',
      ),
      item(
        'order-management',
        'ORDERS',
        'Order management — One Table',
        'Staff dashboard to track, update, and complete orders across dine-in, take-away, and delivery.',
      ),
      item(
        'tables',
        'TABLES',
        'Tables & floor plan — One Table',
        'Manage tables, seat counts, and a visual floor canvas for your dining room.',
      ),
      item(
        'my-shift',
        'MY_SHIFT',
        'My shift & time tracking — One Table',
        'Staff clock in and out to record working hours on shift — simple time tracking for restaurants.',
      ),
    ],
  },
  {
    id: 'business',
    titleKey: 'FEATURES_PAGE.CAT_BUSINESS',
    items: [
      item(
        'products',
        'PRODUCTS',
        'Menu & products — One Table',
        'Manage categories, dishes, prices, images, and modifiers in one menu editor.',
      ),
      item(
        'reports',
        'REPORTS',
        'Sales & revenue reports — One Table',
        'Analyze sales, tips, and revenue trends over time — data for owners and managers.',
      ),
      item(
        'working-plan',
        'WORKING_PLAN',
        'Shift management — One Table',
        'Plan kitchen, bar, and waiter shifts on a calendar or week view.',
      ),
      item(
        'inventory',
        'INVENTORY',
        'Inventory — One Table',
        'Track stock, suppliers, purchase orders, and inventory reports.',
      ),
      item(
        'invoicing',
        'INVOICING',
        'Invoice customers — One Table',
        'Billing customers plus Spain VeriFactu preparation (test mode). Live AEAT filing uses certified middleware when unlocked.',
      ),
      item(
        'tse',
        'TSE',
        'German TSE (KassenSichV preparation) — One Table',
        'Optional per-tenant TSE test/live modes with signed transaction stubs and export preparation — not marketed as BSI-certified until production credentials are verified.',
      ),
      item(
        'contracts',
        'CONTRACTS',
        'Staff contracts — One Table',
        'Store and manage staff employment contracts and templates.',
      ),
      item(
        'restaurant-groups',
        'RESTAURANT_GROUPS',
        'Restaurant groups — One Table',
        'Link multiple locations with a join code and optionally share customers and products across the group.',
      ),
    ],
  },
  {
    id: 'platform',
    titleKey: 'FEATURES_PAGE.CAT_PLATFORM',
    items: [
      item(
        'provider-catalog',
        'PROVIDER',
        'Provider catalog — One Table',
        'Supplier portal for shared product catalogs and provider-managed items.',
      ),
      item(
        'courier-portal',
        'COURIER',
        'Courier portal — One Table',
        'Delivery staff sign in to view and manage delivery orders.',
      ),
      item(
        'users-roles',
        'USERS',
        'Users & roles — One Table',
        'Invite staff with role-based access for admin, waiters, kitchen, and more.',
      ),
      item(
        'settings',
        'SETTINGS',
        'Settings & branding — One Table',
        'Configure your restaurant, payments, languages, modules, and branding.',
      ),
      item(
        'guided-signup',
        'GUIDED_SIGNUP',
        'Guided signup — One Table',
        'Multi-step onboarding collects address, starter menu, optional photos, and a QR for your public menu.',
      ),
      item(
        'saas-paywall',
        'SAAS_PAYWALL',
        'SaaS trial & paywall — One Table',
        'Optionally require new restaurants to start a free trial or subscribe before using the staff app.',
      ),
      item(
        'platform-operator',
        'PLATFORM_OPERATOR',
        'Platform oversight — One Table',
        'SaaS operators view tenant activity, contacts, and public page links from a dedicated platform portal.',
      ),
      item(
        'i18n',
        'I18N',
        'Multi-language — One Table',
        'Guest and staff UI in multiple languages with per-tenant defaults.',
      ),
      item(
        'open-source',
        'OPEN_SOURCE',
        'Open source — One Table',
        'Self-host or run in the cloud — inspect, extend, and avoid vendor lock-in under AGPLv3.',
      ),
    ],
  },
];

export const FEATURE_LANDINGS: FeatureLanding[] = FEATURE_CATEGORIES.flatMap((c) => c.items);

const bySlug = new Map(FEATURE_LANDINGS.map((f) => [f.slug, f]));

export function getFeatureLanding(slug: string): FeatureLanding | undefined {
  return bySlug.get(slug);
}

export function featureDetailKey(slug: string, suffix: string): string {
  return `FEATURE_DETAIL.ITEMS.${slug}.${suffix}`;
}
