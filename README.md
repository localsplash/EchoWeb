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
- `NOCODB_BASE_URL`
- `NOCODB_API_TOKEN`

Those two, and nothing else — see **Configuration** below.

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
| `NOCODB_BASE_URL` / `NOCODB_API_TOKEN` | Where `trustedCIDR` lives (below) |

**`trustedCIDR` is the one setting read from outside the Echo database.** It
is platform-wide network policy that identity and every application have to
agree on, so it is spelled once — in the NocoDB base `IdentityBase`, table
`auth_tbl_Settings` — rather than copied into each app's own settings. That
base is found by *name* at runtime, never by an ID from a config file: an ID
survives a rename and outlives a restore. Pin `IDENTITY_TRUSTED_NETWORK` in
the environment and NocoDB is not consulted for it at all.

Both sources are cached for 30 seconds, so a change reaches a running app
without a restart, and both drop their cache on failure so the next attempt
re-reads rather than trusting something unconfirmed. There is no fallback to
defaults: one retry at startup then exit, `503` at runtime, and `/healthz`
answers throughout because it needs no settings.

Any settings key may be pinned in the environment as an override (blank counts
as unset) — see `.env.example`.
