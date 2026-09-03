# Connexli MVP

Sealed-proposal marketplace for real estate representation. Utah pilot.

## What this is

- Homeowners create private listing requests (24-hour, 48-hour, or 7-day proposal windows)
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
| PAYMENTS_PROVIDER | Unset = credit purchasing OFF ("Coming soon"). `stripe` = Stripe Checkout (needs the two keys below, set only in Render env vars). `mock` = pretend checkout for tests; refused when NODE_ENV=production |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET | Stripe keys — never in code or GitHub. Webhook endpoint: `/webhooks/stripe` (event `checkout.session.completed`) |
| APP_URL | Public app URL used in emails and payment return links (default https://app.connexli.com) |

Opportunity timing (Sep 2): requests submitted 7:00 PM – 6:59:59 AM Mountain Time are saved
immediately but go live — and notify professionals — at the next 7:00 AM Mountain Time
(`schedule.js`, real America/Denver zone, DST-aware). The consumer's proposal window and the
purchased-credit priority window both start from that go-live moment.

The database schema is created automatically on first boot. No migration step.
