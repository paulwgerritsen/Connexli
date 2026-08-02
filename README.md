# Connexli MVP

Sealed-proposal marketplace for real estate representation. Utah pilot.

## What this is

- Homeowners create private listing requests (48-hour, 72-hour, or 7-day proposal windows)
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

The database schema is created automatically on first boot. No migration step.
