# Smart plaque request and fulfilment

Scanaki separates restaurant table creation from manufacturing permanent QR/NFC plaques.

## Restaurant owner

1. Open **Operations → QR/NFC plaque requests**.
2. Enter the quantity, delivery contact, delivery address and optional notes.
3. Submit the request. Only one active request is allowed per restaurant.
4. Follow approval, preparation, shipping and tracking on the same page.
5. When the parcel arrives, select **Confirm plaques received**.
6. Open **Tables**, choose a room/table, select **QR/NFC**, and scan the delivered plaque.
7. Write and verify the NFC URL, physically install the plaque, then select **Mark installed**.

The request completes automatically after every allocated plaque is installed.

## Platform operator

1. Open **Platform → Smart plaques**.
2. Review the restaurant, quantity and delivery information.
3. Select **Approve and allocate**. Scanaki reserves available inventory first and generates any missing unique plaque IDs automatically.
4. Download the request-specific manufacturing sheet.
5. Mark the request **Preparing**, enter the courier/tracking reference, and mark it **Shipped**.
6. The restaurant normally confirms receipt. A platform operator may mark it delivered when fulfilment records prove delivery.
7. Monitor allocated and installed counts until completion.

## Lifecycle and controls

Request lifecycle:

`Requested → Approved → Preparing → Shipped → Delivered → Completed`

Plaque lifecycle:

`Available → Reserved → Preparing → Shipped → Delivered → Assigned → Tested → Installed`

- Plaques reserved for one tenant cannot be taken by another tenant.
- A shipped plaque cannot be assigned until delivery is confirmed.
- Cross-restaurant transfers require a platform release.
- Reassignment rotates hidden table access and rejects old baskets.
- NFC verification is required before a plaque can be marked installed.
- Request transitions and plaque assignments are retained in audit history.

