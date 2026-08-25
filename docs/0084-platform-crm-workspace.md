# Platform CRM workspace

All authenticated platform-operator routes render inside one responsive CRM shell.

## Navigation

The left navigation groups tools by operator intent:

- Workspace: Overview and Restaurants
- Revenue: Subscriptions and Pricing & offers
- Operations: Smart plaques and Platform settings

Create restaurant remains available as the primary quick action. The operator identity and logout action stay at the bottom of the sidebar. Restaurant detail routes retain the Restaurants context highlight.

On viewports below 900px, the sidebar becomes a modal drawer opened from the top bar. Selecting a route closes the drawer. The page and drawer avoid document-level horizontal overflow; wide operational tables scroll inside their own containers.

## Overview

The overview combines:

- monthly recurring revenue and active subscription count;
- restaurant, trial, past-due and 30-day revenue metrics;
- the five newest restaurant accounts;
- active, trialing, suspended, canceling and churned subscription counts;
- the ten most recent successful account logins.

Loading uses layout-matched skeleton rows. Empty states link operators to the relevant creation or management action.

## Restaurant directory

`/platform/restaurants` provides client-side search by restaurant, owner or email and an onboarding-status filter. The directory includes plan, allowance, current usage, account contacts, creation date and links to the tenant detail and public menu.

## Route structure

The public `/platform/login` route remains outside the authenticated shell. The protected `/platform` parent route owns the shared layout and lazy-loads each existing child without changing its public URL.
