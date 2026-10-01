# Connexli MVP

Sealed-proposal marketplace for real estate representation. Utah pilot.

## What this is

- Homeowners create private listing requests (sellers also say when they're hoping to list). One standard rule
  for every round, seller and buyer: up to 48 hours or until 10 proposals arrive, whichever comes first. After a
  round closes, "Get 10 more proposals" opens another round on the SAME request (up to 10 more, only for
  professionals who haven't proposed; earlier proposals stay selectable; details can't be edited between rounds).
  Admin request pages show a round history.
- Professionals can practice both a seller and a buyer proposal from their dashboard (`/agent/practice`) —
  fictional requests, previews of what the consumer sees, and zero production effects (no records, credits,
  emails or events)
- License-verified professionals submit sealed proposals (fee + services + marketing plan)
- Proposals stay hidden until the window closes, then the homeowner compares, shortlists, and connects
- Contact info is released only to the chosen professional
- Admin panel: professional verification queue + pilot metrics

## Deploy on Render (recommended)

1. Push this folder to a GitHub repository.
2. In Render: **New → Blueprint** → select the repository → **Apply**.
   Render reads `render.yaml` and creates the web service + Postgres database together.
3. When prompted, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (the first admin login).
4. Open the app URL, log in as admin, and you're live.

## Run locally

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/connexli node server.js
```

Environment variables:

| Variable | Purpose |
|---|---|
| DATABASE_URL | Postgres connection string |
| SESSION_SECRET | Cookie signing secret (any long random string) |
| ADMIN_EMAIL / ADMIN_PASSWORD | Seeded admin account on first boot |
| PRIORITY_HOURS | Purchased-credit priority window after an opportunity goes live (default 3) |
| FREE_PROPOSALS_PER_MONTH | Complimentary proposal credits per professional per month (default 5) |
| CREDIT_BUNDLES | Optional JSON overriding credit packages/prices (see db.js) |
| RELD_API_KEY / RELD_API_BASE_URL | RELD license verification (see "License verification" below) |
| RELD_BATCH_SIZE | Licenses per RELD batch call for the admin audit (default and maximum 100; larger batches are split automatically) |
| PAYMENTS_PROVIDER | Unset = credit purchasing OFF ("Coming soon"). `stripe` = Stripe Checkout (needs the Stripe variables below, set only in Render env vars). `mock` = pretend checkout for tests; refused when NODE_ENV=production |
| STRIPE_SECRET_KEY | Stripe secret key (`sk_test_…` first, `sk_live_…` only after the test-mode checklist passes). Server-side only — never in code, GitHub, or a chat |
| STRIPE_WEBHOOK_SECRET | Signing secret (`whsec_…`) of the webhook endpoint `/webhooks/stripe`. Without it every webhook is rejected |
| STRIPE_PUBLISHABLE_KEY | Public key (`pk_…`). Not used by hosted Checkout today; documented so it lives with the others if Stripe Elements is ever added |
| STRIPE_PRICE_SINGLE / STRIPE_PRICE_BUNDLE5 / STRIPE_PRICE_BUNDLE11 / STRIPE_PRICE_BUNDLE25 | Stripe Price IDs (`price_…`) for each credit package. If a package has no Price ID, Checkout is created with an ad-hoc price from CREDIT_BUNDLES instead — so the app works without them, but Stripe reports are cleaner with them |
| STRIPE_TAX_ENABLED | `true` turns on Stripe Tax calculation in Checkout. Leave unset/false until tax collection is a business decision and Stripe Tax is enabled in the Stripe dashboard |
| APP_URL | Public app URL used in emails and payment return links (default https://app.connexli.com) |

### Marketing source attribution (?source=)

Any app link can carry `?source=<slug>` (lowercase letters, digits, `-` or `_`, up to 32
characters) — e.g. the connexli.com/fsbo page links to `/register?source=fsbo`. The first
valid source in a browser session is remembered. It is saved on the account
(`users.signup_source`) at registration and on each seller request (`requests.source`:
the session's source, else the account's signup source). Registration and the seller
request flow are otherwise unchanged. Admin → Analytics → "Seller requests by source"
shows accounts, requests, last-30-day requests and connections per source.

### Payments (Stripe) — setup order

1. Create the Stripe account (business details, bank account, EIN). Stay in **Test mode** in the Stripe dashboard.
2. Products → create four products/prices matching CREDIT_BUNDLES (1/$10, 5/$50, 11/$100, 25/$200), copy each `price_…` into the `STRIPE_PRICE_*` variables. Optional but recommended.
3. Developers → API keys → copy the **test** secret key into `STRIPE_SECRET_KEY` in Render.
4. Developers → Webhooks → add endpoint `https://app.connexli.com/webhooks/stripe` and subscribe to:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired`, `charge.refunded`, `refund.updated`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Set `PAYMENTS_PROVIDER=stripe` and redeploy. Run the test-mode checklist (card 4242 4242 4242 4242 pays; 4000 0000 0000 0002 declines) and check Admin → Payments & revenue.
6. Only then switch the three secrets to the **live** values. Never paste any secret into code, GitHub, or a chat.

How fulfilment works: the browser never grants credits. Stripe's webhook (verified by signature, processed once per event id) is the authority; the return page is a backup that re-checks the session server-side with the secret key. Both paths write the same order row and one ledger entry, so a duplicate can't double-credit. Refund events reverse only unused paid credits and flag anything that can't be reversed for admin review — a balance is never taken below zero.

Opportunity timing (Sep 2): requests submitted 7:00 PM – 6:59:59 AM Mountain Time are saved
immediately but go live — and notify professionals — at the next 7:00 AM Mountain Time
(`schedule.js`, real America/Denver zone, DST-aware). The consumer's proposal window and the
purchased-credit priority window both start from that go-live moment.

The database schema is created automatically on first boot. No migration step.
