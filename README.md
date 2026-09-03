# EchoWeb

Frontend web app for Echo messaging.

## Architecture
- **EchoWeb** = login/session + browser UI
- **EchoService** = mid-tier API, Bandwidth integration, webhooks, and database access
- **Production EchoService URL** = `https://io.echo.wisp.net`

EchoWeb should not connect directly to MySQL.
All data I/O flows through `ECHO_SERVICE_BASE_URL`.

## Local Run
```bash
cp .env.example .env
npm install
npm run dev
```

## Required Environment
- `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`

Those, and nothing else — see **Configuration** below. In particular there is
no NocoDB token to obtain: this app reads nothing from NocoDB.

## Dev Model
For local development on Windows/macOS/Linux, run EchoWeb locally and point it at the shared mid-tier:

- `ECHO_SERVICE_BASE_URL=https://io.echo.wisp.net`

That lets a remote developer run the UI without needing MySQL or the Bandwidth webhook stack locally.

## Configuration

EchoWeb reads its settings from the **Echo database**, table
`echo_tbl_Settings` — rows where `sApp` is `'*'` (read by every Echo app) or
`'web'` (this one), with the app's own row winning over the general one. The
table is defined in EchoDatabase, `init/009_settings.sql`; adding a
web-specific setting is a row with `sApp='web'`, never a new table.

The `.env` carries only what cannot describe itself:

| Variable | Why it is here |
| --- | --- |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Where `echo_tbl_Settings` lives — a database cannot carry its own address |

That is the entire list, which is the point: give this app a database and it
runs. It needs no NocoDB credentials and no first-run wizard.

It used to need them, for one value — `trustedCIDR`, the platform-wide network
policy held in the NocoDB base `IdentityBase`. EchoWeb fetched it, hung it on
the config object, and never read it back, while making a NocoDB token a hard
requirement for starting at all. So the fetch is gone (#17). EchoService still
reads that row, because it genuinely enforces the policy — deciding which
callers may skip webhook basic auth. EchoWeb enforces nothing of the kind, so
it no longer asks.

Settings are cached for 30 seconds, so a change reaches a running app without
a restart, and the cache is dropped on failure so the next attempt re-reads
rather than trusting something unconfirmed. There is no fallback to defaults:
one retry at startup then exit, `503` at runtime, and `/healthz` answers
throughout because it needs no settings.

Any settings key may be pinned in the environment as an override (blank counts
as unset) — see `.env.example`.
