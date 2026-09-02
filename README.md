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

EchoWeb reads its settings from NocoDB: the base **`IdentityBase`**, table
**`auth_tbl_Settings`** (see localsplash/identify#15). The `.env` carries
`NOCODB_BASE_URL` and `NOCODB_API_TOKEN` and nothing else; every other value
is a row in that table, shared with every other application.

The base is found by **name** at runtime — a base ID in a config file
survives a rename and outlives a restore. Values and the resolved base/table
IDs sit on one 30-second clock, so a change in NocoDB reaches a running app
without a restart; any failure drops the cache so the next attempt
re-detects. There is no fallback: one retry at startup then exit, and `503`
at runtime. `/healthz` needs no settings and keeps answering.
