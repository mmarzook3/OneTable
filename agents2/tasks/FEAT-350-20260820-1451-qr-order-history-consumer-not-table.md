# QR menu order history: consumer-bound, not table-bound

## Status
- **Blocked (2026-08-20):** Feature coder (010) re-checked issue #350. Questions 1–5 still lack an explicit human decision comment. Left as **FEAT** (no WIP rename; no code). Do not add `agent:wip` until humans decide.

## GitHub Issues
- **Issue:** https://github.com/satisfecho/pos/issues/350
- **350**

## Problem / goal

The public scanned ordering page (`/menu/{table_token}`) loads table-bound paid/completed order history via `GET /menu/{table_token}/order-history` and shows it to anyone with the QR. That hurts UX (noise on a long-lived table) and privacy (other guests’ line items). Product intent: history belongs to the **consumer account**, not the table.

**Hard gate (human in the loop):** Issue #350 is a **design discussion**. Agents must **not** change behaviour until humans record decisions on the issue’s questions (hide vs session-only history; unsettled shared cart vs history; attach `customer_id` on table order; default “hidden until login / last 3”; keep staff/back-office table view). Until then: no API/UI removal or rewrite.

Relevant context: public menu + rate limits (`docs/0020`), session/order model (`docs/0008`, `docs/0009` shared draft cart #349), end-user customer plan (`docs/0002` — customer order history not fully shipped as consumer-facing account history on the QR page).

## High-level instructions for coder

- **Stop if undecided:** Re-read https://github.com/satisfecho/pos/issues/350. If questions 1–5 lack an explicit human decision comment, leave this task as **FEAT** (do not rename to WIP, do not ship code). Comment on the issue that work is blocked on decision.
- After humans decide, implement only the agreed policy in the smallest slice:
  - Anonymous QR: typically **do not** show other parties’ paid table history.
  - Logged-in consumer: optional short “my” history from account identity (not table token alone), if that path exists / is approved.
  - Keep unsettled / shared draft cart (#349) distinct from historical paid orders.
  - Do not remove staff/ops table order views unless the decision says so.
- Prefer privacy-safe defaults; keep tenant scoping and public rate limits consistent with `docs/0020`.
- Update the relevant docs (0008/0009/0002 or short ADR) when behaviour changes.
- Smoke: QR `/menu/{token}` still orders; history UI matches the decided policy; no secrets in follow-ups.
