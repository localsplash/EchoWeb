# EchoWeb

Frontend web app for Echo messaging.

## Architecture
- **EchoWeb** = login/session + browser UI
- **EchoService** = mid-tier API, Bandwidth integration, webhooks, and message data

Message and media I/O is proxied to `ECHO_SERVICE_BASE_URL`. EchoWeb talks to
MySQL only for its own concerns — sessions, users, orgs, and the settings table
below.

## Local Run
```bash
cp .env.example .env      # then export it, or run via docker compose
npm install
npm run dev
```

There is no dotenv here: `npm run dev` reads the process environment, and
`.env` is what Docker Compose substitutes into `docker-compose.yml`.

## Required Environment

| Variable | Why it is here |
| --- | --- |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Where `echo_tbl_Settings` lives — a database cannot carry its own address |
| `NOCODB_BASE_URL` / `NOCODB_API_TOKEN` | Where `PARENT_DOMAIN` and `IDENTITY_CLIENT_SECRET` live — the platform's, not this app's. On a single-host install identity's `/data/config.json` supplies both and neither needs stating |

That is the entire list. `PORT` (3160), `NODE_ENV` and `LOG_LEVEL` have
defaults; everything else is a settings row.

## Configuration

EchoWeb reads its settings from the **Echo database**, table
`echo_tbl_Settings` — rows where `sApp` is `'*'` (read by every Echo app) or
`'web'` (this one), with the app's own row winning over the general one. The
table is defined in EchoDatabase, `init/009_settings.sql`; adding a
web-specific setting is a row with `sApp='web'`, never a new table.

`PARENT_DOMAIN` and `IDENTITY_CLIENT_SECRET` come from the NocoDB base
`IdentityBase` instead, because the platform decides them once for everybody.
Every public URL follows from `PARENT_DOMAIN`, so moving the platform to a new
domain is one edit rather than a hunt through rows:

| Setting | Derived as | Pinned by a row when it differs |
| --- | --- | --- |
| `APP_BASE_URL` | `https://echo.<parent>` | yes |
| `MEDIA_BASE_URL` | `https://media-echo.<parent>` | yes |
| `IDENTITY_BASE_URL` | `https://identity.<parent>` | yes |
| `ECHO_SERVICE_BASE_URL` | not derived — internal, container-to-container | required |

Settings are cached for 30 seconds, so a change reaches a running app without
a restart, and the cache is dropped on failure so the next attempt re-reads
rather than trusting something unconfirmed. There is no fallback to defaults:
one retry at startup then exit, `503` at runtime, and `/healthz` answers
throughout because it needs no settings.

Any settings key may also be pinned in the environment, where it **overrides**
the row (blank counts as unset) — see `.env.example` for the full list. A stale
override wins over a correct row, so pin only what you mean to override.
