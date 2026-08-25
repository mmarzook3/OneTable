# Kitchen stock control

Scanaki kitchen and bar staff can mark dishes and drinks available or sold out without receiving permission to edit the menu catalogue or prices.

## Staff workflow

1. Sign in with a Kitchen, Bartender, Admin or Owner account.
2. Open **Kitchen display** or **Beverages display**.
3. Select a station when the venue uses multiple preparation stations.
4. Select **Stock**.
5. Search or scan the image cards, then uncheck anything that is sold out.
6. Select **Save stock**.

The change is immediate. Sold-out products are removed from customer ordering menus, while checked products remain orderable. Linked restaurant catalogue entries are kept in sync.

## Permissions and safety

- Kitchen and Bartender roles receive `product:availability` only.
- Product content, pricing and catalogue management continue to require `product:write`.
- Every read and update is scoped to the signed-in restaurant.
- A bulk update is rejected in full if it contains a duplicate, missing or cross-restaurant product.
- The save endpoint accepts availability values only.

## Current scope

Availability is restaurant-wide in the current single-menu model. The Stock window filters what staff see by Kitchen, Bar and preparation station, but a sold-out product is unavailable to all ordering points for that restaurant. Location-specific stock will build on the multi-location model described in [0085-multi-location-hotel-ordering-requirements.md](0085-multi-location-hotel-ordering-requirements.md).
