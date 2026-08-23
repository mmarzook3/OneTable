# OneTable reusable QR and NFC plaques

OneTable separates the physical plaque identity from the restaurant table. A manufactured plaque contains one permanent, random URL:

```text
https://<one-table-host>/p/{public-code}
```

The public code belongs to the physical QR/NFC plaque and never contains a tenant ID or table number. OneTable resolves its current assignment and forwards the guest to the table menu. Moving a plaque therefore does not require printing a new QR or rewriting a locked NFC tag.

## Manufacturing inventory

Platform operators open `/platform/smart-plaques` to:

1. enter a batch label and quantity;
2. generate cryptographically random permanent public codes;
3. download a high-error-correction PDF contact sheet;
4. track whether each plaque is available or assigned.

`PUBLIC_APP_BASE_URL` must already be the permanent OneTable production host before physical manufacturing. The assignment is reusable, but changing the hostname printed inside the QR still requires a new plaque.

## Restaurant assignment

Owners and staff with `table:write` permission open **Tables**. Adding a table automatically opens the setup sheet; existing tables expose **Assign QR & NFC**.

1. Tap **Scan the plaque QR** and allow camera access. Android Chrome's QR detector is used when available.
2. If camera scanning is unavailable, enter the code printed below the QR.
3. Confirm the current and target tables. Moving an assigned plaque or replacing a table's existing plaque is explicit.
4. Optionally tap **Write NFC** on Android Chrome over HTTPS, then tap again to read back and verify the saved URL.
5. Finish and install the plaque.

Web NFC requires an NDEF-compatible tag. The permanent URL can be copied into a trusted NFC-writing application when Web NFC is unavailable. Use ferrite-backed/on-metal tags when the plaque touches metal.

## Reassignment and security

- Public codes are high-entropy and cannot be chosen by restaurant users.
- Tenant ownership comes from the authenticated user, never from the scanned payload.
- A restaurant cannot take a plaque assigned to another tenant. A platform operator must release it first.
- Reassignment is blocked while the source or target table has a live session/order.
- Reassignment rotates the source and target tables' hidden access tokens, invalidating bookmarked direct menu sessions.
- The physical `/p/{code}` address remains unchanged and immediately resolves the new table.
- Every assignment, reassignment, release, replacement and tenant purge is recorded in `smart_plaque_assignment_event`.
- Deleting a table or tenant returns its plaque to OneTable inventory instead of deleting the physical identity.

An unassigned, disabled or unknown public plaque displays a safe guest-facing message and never exposes another restaurant's assignment.

## APIs

- `POST /platform/smart-plaques/batch` — generate inventory.
- `GET /platform/smart-plaques` — operator inventory.
- `GET /platform/smart-plaques/contact-sheet.pdf` — manufacturing sheet.
- `GET /smart-plaques/lookup?value=...` — tenant-safe scan lookup.
- `POST /smart-plaques/assign` — assign or confirm reassignment.
- `PUT /smart-plaques/{id}/nfc` — record write/read-back/lock state.
- `DELETE /smart-plaques/{id}/assignment` — return a tenant plaque to inventory.
- `GET /public/smart-plaques/{code}` — public current-table resolution.

Backend coverage is in `back/tests/test_smart_plaques.py`. The browser smoke is `front/scripts/test-smart-plaque-setup.mjs`.
