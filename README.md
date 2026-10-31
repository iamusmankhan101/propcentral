# Prop Central

Real estate CRM, Phase 1 of the PRD (lead control and accountability). React + Vite frontend, Express API on a libSQL/SQLite database (local file or Turso).

## Run

```bash
npm install
npm run dev        # API on :3001, UI on http://localhost:5173
npm test           # business-logic checks
```

Production: `npm run build && npm start` serves the UI and API on `PORT` (default 3001). Without `TURSO_DATABASE_URL` the API uses the local `./crm.db` file.

The first run seeds demo users (password `password123`): `admin@propcentral.local`, `head@propcentral.local`, `lead@propcentral.local`, `agent1@propcentral.local`, `agent2@propcentral.local`. Change these passwords before going live.

## Environment

Put these in a `.env` file in the project folder (loaded automatically, never commit it).

| Variable | Purpose |
|---|---|
| `PORT`, `DB_PATH` | Server port, local database file (default `./crm.db`). Ignored when `TURSO_DATABASE_URL` is set |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Turso database URL (`libsql://…`) and token. Required on Vercel |
| `CRON_SECRET` | Bearer secret for `/api/cron/tick` (SLA, lease and weekly-report jobs) |
| `FB_VERIFY_TOKEN`, `FB_APP_SECRET`, `FB_PAGE_TOKEN` | Optional fallback. Normally an admin connects Facebook in **Settings › Facebook** (paste app secret + Graph API Explorer token; the CRM makes a permanent Page token, registers the webhook at `/api/webhooks/facebook` and subscribes the Page) |
| `INBOUND_API_KEY` | `POST /api/inbound` with header `x-api-key`. For website forms, Zapier, portal email parsers and telephony |

Both integration endpoints stay disabled until their variables are set.

## Deploy to Vercel

The API runs as one serverless function (`api/[...path].js`) and the Vite build is served statically. The database lives in Turso, so nothing is written to the function's filesystem.

1. Create the database with the [Turso CLI](https://docs.turso.tech/cli/introduction): `turso db create propcentral`, then copy `turso db show propcentral --url` and `turso db tokens create propcentral`.
2. In the Vercel project, add `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CRON_SECRET` (plus the Facebook / inbound variables if used) under **Settings › Environment Variables**, for Production and Preview.
3. Deploy. Tables, migrations and the demo seed run automatically on the first request.
4. Check `https://<app>/api/health` after deploying. It reports `ok`, whether the database is Turso or a local file, and the exact init error when the database cannot be reached (the rest of the API answers 503 in that case).
5. `vercel.json` registers a daily Vercel Cron for `/api/cron/tick`. Vercel sends `Authorization: Bearer $CRON_SECRET` for you. On the free plan the schedule cannot be more frequent than daily; for minute-level SLA checks either upgrade (cron `*/5 * * * *`) or point an external scheduler such as cron-job.org at `https://<app>/api/cron/tick` with the same bearer header.
6. Keep local `.env` values out of Git; only add them in Vercel.

Limits to know: serverless functions cap request/response bodies at ~4.5 MB (large society-map SVGs or photo payloads may exceed it; media itself is stored in the database), and every database call is a network round trip, so heavy pages take longer than a local file.

## What's built (PRD refs)

- **M1 Leads:** phone normalisation, duplicate detection that attaches repeat inquiries to the open lead and notifies its owner, multiple leads per contact, timeline, scoring, Lost/Junk with reason, note and team-lead approval, recycle pool, CSV import with dry-run report, custom fields
- **M2 Capture:** Facebook/Instagram webhook with campaign, ad set and ad stored permanently; generic inbound API; walk-in entry with agent pick
- **M3 Assignment:** prioritised rules (source, city, project, budget, hours…), with round-robin, load-based, performance or specific agent; skips agents who are unavailable or at capacity; returning contacts go back to their previous owner; reassignment needs a reason; offboarding redistributes leads
- **M4 SLA:** per-source first-contact SLA counted in working minutes per branch. 1× reminds the agent (SMS), 2× alerts the team lead, 3× reassigns. Every activity needs a next follow-up date. Stale-lead alerts
- **M5/M7:** activities and follow-ups; site visits with GPS radius check-in, customer SMS OTP, mandatory feedback, and unverified/overdue flags
- **M9 Dashboards:** KPI tiles against the PRD targets, funnel, agent leaderboard (avg/median response, breaches, calls, visits), source/campaign table, lost reasons, all filterable
- **M10 Projects & inventory:** land (phase/block/street/plot) or building (tower/floor/unit) projects, bulk unit creation, colour-coded inventory map, marla/kanal/sq ft/sq yd conversion with per-project marla size, premium factors, versioned price lists with effective dates, holds that expire on their own with a per-agent limit, race-safe hold and booking, unit history, share to WhatsApp. Booking a unit marks its lead Booked. Plot map: upload an SVG (plan image + one path per plot in `<g id="plots">`) under Setup, link plots to units by clicking them, and the Inventory › Map view colours each plot by its live status. `maps/reva.svg` is the Reva masterplan
- **M22–M24:** role-scoped data (agent, team, branch, all), permission matrix editable in Settings, JSON settings for every rule, phone masking by role, append-only audit log (logins, views, exports, changes), watermarked export, soft delete, login lockout

- **Collections:** payment plan per allotment (down payment + monthly/quarterly/half-yearly/yearly installments), payments and refunds with printable receipts (`RC-00001`), void with reason, customer ledger with overdue status (payments applied oldest installment first), transfer to a new owner with a receipted fee, Collections page of overdue and plan-less allotments. Permission `payments` (accounts, sales head, admin)
- **Sales & commissions:** external dealers (own rate or default), dealer tagged on a lead, commission created at allotment for the lead's agent and dealer (`commission` setting, default agent 1% / dealer 2%), mark paid, pending ones cancelled with the sale and paid ones flagged for recovery, dealer balances, monthly targets vs sales per agent with conversion. Agents see only their own figures
- **Security & control:** two-factor login with an authenticator app (My account, via the avatar; admins can reset it under Users); branch managers request lead exports, sales head/admin approve, each approval downloads once. New agents can sign up from the login page; the account stays inactive until an admin activates it under Users. Sign-in and sign-up are rate-limited per address and per account, with counters in the database so limits hold across serverless instances. Passwords use scrypt with a 10+ character letter-and-number policy; a forgotten password notifies admins, who hand over a one-time reset link (hashed at rest, 30-minute expiry) that signs the account out on every device
- **Customer side:** customer portal link per buyer (from the ledger, shared on WhatsApp, no login) showing their plots, schedule, overdue and receipts; printable booking application form with applicant, nominee, plan and CNIC copies
- **Inventory & media:** third-party listings (resale/rental from outside owners, owner saved as a seller/landlord lead, photos, WhatsApp share); project media tab for brochures, floor plans, photos (shareable links) and video links
- **Reports:** weekly sales & collections email (`weekly_report` setting, preview/send now in Settings). Email is a console stub in `sendEmail()` until an SMTP/email API is plugged in
- **Properties (rentals & management):** societies, phases and blocks are drawn on the map as boundaries (Properties › Societies) with counts per area; society / phase plans (JPG/PNG) can be uploaded, are auto-fitted over their boundary and aligned to the satellite by matching 2+ points (3+ also corrects stretch/skew), with opacity and show/hide; a property is added by clicking the map and takes the society / phase / block it falls in (moving the pin updates them). Every managed property sits on a MapTiler satellite map of Lahore (Settings › Maps for the key, labels in English), with a pin and an optional plot outline drawn on the map, coloured by status: let, ending (amber, `lease_amber_days`), ending soon / rent overdue (red, `lease_red_days`), vacant. Owner and tenant with one-tap call/WhatsApp; leases with deposit, yearly increase, police registration and agreement no.; monthly rent schedule with overdue tracking (a tenant's renewals form one rent account, so arrears carry over); rent, deposit and refund receipts (`RR-00001`); renew / move-out; maintenance jobs charged to owner, tenant or company; owner statements for managed properties (rent − fee − owner costs − payouts) and payouts. Lease-ending alerts go to the property agent (SMS at red) and to property managers. Permission `properties`
- **Agent reports:** Reports page with daily, weekly (Mon–Sun) and monthly figures per agent: new leads, contact rate, response time, SLA breaches, calls/connected, other activity, visits, offers, bookings, sales, commission, lost, open and overdue follow-ups; drill into one agent for a day-by-day breakdown, bookings and activity log; CSV and print. Agents see themselves, team leads their team
- **Commissions:** pending commissions can be adjusted or cancelled with a reason
- **Also:** unit photos (up to 12, downsized in the browser), client/company offers on a lead (moves it to Negotiation)

## Not built yet

- **SMS/push:** these are console stubs in `sendSms()` in `server/server.js`. Wire in the local SMS gateway and FCM there.
- **Phase 1 items that wait on decisions or vendors:**
  - Cloud telephony: click-to-call, logging, recording, masking (A3/R2)
  - WhatsApp Business API
  - Native mobile app with offline mode and device binding; the web UI is responsive in the meantime
  - Meta spend import, so there's no cost per lead yet
  - Email delivery for the weekly report (needs SMTP or an email API)
- **Still open:** SMS installment reminders (needs the SMS gateway), required 2FA per role.
- **Scale:** the API keeps better-sqlite3's synchronous query style over libSQL. A single process handles one query at a time; Turso adds network latency per query, so move hot paths to batched queries or a Postgres driver before the 1,000-user target (A1).
