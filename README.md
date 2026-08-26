# EchoWeb

Frontend web app for Echo messaging.

## Architecture
- **id** (`id.<parent-domain>`) = OAuth identity processor: all sign-in (Google, Microsoft, UISP bridge) happens there
- **EchoWeb** = app session + org membership + browser UI
- **EchoService** = mid-tier API, Bandwidth integration, webhooks, and database access
- **Production EchoService URL** = `https://io.echo.wisp.net`

## Sign-in
EchoWeb has no login page. A visitor without a session is redirected to
`id/authorize` with a `redirect_uri` back to `/auth/callback`; the returned
one-time code is redeemed server-to-server for the identity, and Echo then
maps the id user onto an org (provisioning from the UISP CRM on first
entry). Sessions persist until revoked. Shared settings (where id lives,
the exchange secret, UISP CRM access) come from the NocoDB `oAuthConfig`
table — the env only carries `NOCODB_BASE_URL` / `NOCODB_API_TOKEN`.

EchoWeb should not connect directly to MySQL.
All data I/O flows through `ECHO_SERVICE_BASE_URL`.

## Local Run
```bash
cp .env.example .env
npm install
npm run dev
```

## Required Environment
- `ECHO_SERVICE_BASE_URL`

## Dev Model
For local development on Windows/macOS/Linux, run EchoWeb locally and point it at the shared mid-tier:

- `ECHO_SERVICE_BASE_URL=https://io.echo.wisp.net`

That lets a remote developer run the UI without needing MySQL or the Bandwidth webhook stack locally.
