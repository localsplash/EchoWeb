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

## Staying in step with id
EchoWeb's session is its own row behind its own cookie, independent of the
id session that created it — so a revocation at id is invisible here unless
id says so. On boot EchoWeb registers `POST /id/events` with id (see id's
README for the contract), gets back the secret that signs deliveries, and
catches up on anything missed via `GET id/api/events?since=`. No polling,
no cron.

It acts on `session.revoked` (drops its own sessions for that id user) and
`user.merged` (repoints `auth_tbl_User.iIdUserId`). Handlers are idempotent
because failed deliveries are retried. If registration hasn't succeeded,
the receiver refuses events rather than trusting unverifiable ones — and id's
`/admin` shows the app as not integrated.

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
