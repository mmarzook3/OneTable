# The Yew Trees pilot inputs

Recorded: 26 August 2026

This document records the platform-owner answers used to configure the pilot. `TBP` fields remain the responsibility of The Yew Trees team or require a secure configuration step.

## Scanaki profile

- Company/display name: **Scanaki (Powered by Fixaki)**
- Public email sender name: **Scanaki**
- Support and contact email: **support@scanaki.uk**
- Phone: **07405 329242**
- Address: **F1 Enterprise House, Coventry, CV6 5NX**
- Website: **https://scanaki.uk**
- Company number: N/A
- VAT number: N/A
- Terms: **https://scanaki.uk/terms**
- Privacy: **https://scanaki.uk/privacy**
- Platform recovery email: **mmarzook3@gmail.com** (account update still required)

## SMTP and operations

- Provider: Google Workspace
- Recommended SMTP host: `smtp.gmail.com`
- Recommended port: `587`
- Encryption: STARTTLS enabled
- Intended SMTP username/sender: `support@scanaki.uk` (must be a licensed mailbox or an approved alias of the authenticated mailbox)
- Recommended test recipient: `mmarzook3@gmail.com`
- Alert recipient: `alerts@scanaki.uk` Google Workspace group
- Off-VPS backup: Google Drive
- Maintenance time: 02:00 UK time (day TBP)
- Remote ordering: permitted when fully paid and the customer confirms the table/room
- Pilot end: manual platform-owner decision; no automatic expiry
- Support: 24/7 during the pilot
- Pilot plaques: free
- Replacement plaque: £5 each
- Public subscription billing: remains disabled during the pilot

Do not store Google app passwords, Stripe secrets or bank information in this document.

## Venue profile

- Name: The Yew Trees Pub
- Address: 15 Enderby Rd, Blaby, Leicester LE8 4GD
- Website: https://theyewtrees.co.uk/
- Owner email: admin@theyewtreespub.co.uk (may be changed later)
- Phone: TBP in tenant admin
- Company/VAT numbers: N/A
- Existing public description: approved
- Logo: stated as ready; file still required in the workspace/admin upload

## Ordering points

- The Yew Trees: 9 indoor tables and 8 outdoor benches
- Sports Lounge: 8 tables
- Premium Building: 13 rooms
- Main Building: no ordering points; location retained inactive
- Total expected plaques/ordering points: **38**
- Outdoor bench capacity: 4
- Indoor table, Sports Lounge and room capacities: provisional until tenant admin confirms

Stable point codes use `I1..I9`, `O1..O8`, `S1..S8` and `R1..R13`; customer labels remain “Indoor Table 1”, “Outdoor Bench 1”, “Table 1” and “Room 1”.

Premium Building uses location menu overrides so the venue can set different prices for the same master products without duplicating the menu.

## Menu

- Current products/prices are not final
- Final menu will be entered by The Yew Trees team
- Temporary AI photographs are allowed
- Allergen information: TBP; tenant must see a prominent readiness alert
- Vegetarian, vegan and spicy tags: approved
- Modifiers: required
- Modifier charging: required, provisional default £0.20 per selected modifier
- Tenant admin must be able to disable modifier charging

## Hours and policies

- Monday–Thursday: 14:00–23:00
- Friday: 14:00–00:00
- Saturday: 12:00–00:00
- Sunday: 12:00–22:30
- Ordering initially follows opening hours for every active location
- Reservations initially follow opening hours
- Average reservation duration: TBP (recommended 90 minutes)
- Scanaki may draft Terms, Privacy, refund, order-cancellation and reservation-cancellation policies for review

## Staff and hardware

- Owner/manager, kitchen holder, incident contacts and training date: tenant admin must provide during readiness setup
- HONOR Pad X8b: purchased, arrived and supplied free by Scanaki
- Prototype plaque count: 3
- Plaque design: black and white
- Outdoor mounting: screwed 3D-printed plaques on wooden benches
- Indoor mounting: UV-printed stickers
- Delivery: handled personally by the Scanaki platform owner

## Stripe live

- Business verification: completed
- Payout bank account: configured
- Recommended statement descriptor: `YEW TREES PUB` (venue approval required)
- Desired live activation: 1 September
- Refund authority: Yew Trees manager

