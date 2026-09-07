# EchoWeb

Echo's messaging browser and backend-for-frontend. Identity owns users, businesses, memberships and browser sessions; EchoService owns messaging operations; EchoDatabase owns historical records and reviewed canonical-ID/number mappings. This app reads its mappings from MySQL and sends messaging operations through `ECHO_SERVICE_BASE_URL`.

## Development and configuration

Use Node 22: `npm ci`, then `npm run dev`. Copy `.env.example` and configure the Echo database and NocoDB bootstrap credentials. Database coordinates remain explicit process settings in this foundation release; moving those into the initial NocoDB bootstrap is a separate deployment change.

By default `SETTINGS_MODE=platform` reads `PlatformConfig/cfg_tbl_Setting` through NocoDB. Resolution is nonblank environment overrides, exact `echo-web`, declared parent `echo`, then global `*`. Blank seeded rows are unset; duplicate bases, tables and scoped keys fail. Runtime reads never create configuration. Settings and resolved IDs refresh every 30 seconds; failures return 503. `/healthz` remains configuration independent. Coordinate changes require restart.

Required application settings are `PARENT_DOMAIN`, `ECHO_SERVICE_BASE_URL` and, where service network trust needs it, `IDENTITY_CLIENT_SECRET`. Public defaults derive from the whitelabel domain: `https://echo.X.TLD`, `https://identity.X.TLD`, `https://media-echo.X.TLD`. URLs can be overridden explicitly. No provider OAuth credentials belong in EchoWeb.

`SETTINGS_MODE=legacy` explicitly reads the older Echo SQL settings plus `IdentityBase/auth_tbl_Settings` during coordinated rollout. It still requires Identity v2 for authentication. There is no automatic fallback from canonical to legacy settings and no settings writer here. Keep the existing Identity bootstrap volume/UID only as long as the deployment still depends on `/data/config.json`; explicit NOCODB environment values take precedence.

## Central-session cutover

Deploy after [Identity PR #18](https://github.com/localsplash/identity/pull/18) and EchoDatabase migration 012, following that repository's `docs/PLATFORM_MAPPING_CUTOVER.md`. Review/import every legacy Echo organization/number-to-tenant mapping and establish equivalent central memberships before switching the application. Existing people, organization IDs, messages, membership and session rows are retained. This version does not create or read local authentication rows as authority, auto-claim CRM accounts by email, or silently assume legacy IDs equal canonical IDs.

The browser exchanges a state-bound Identity code and receives an opaque central application token in `__Host-echo_platform_session` (Secure, HttpOnly, SameSite=Lax). The old `echo_session` cookie is ignored and cleared during the new login/logout; existing users authenticate through the preserved central SSO account. An unsolicited UISP/Identity entry starts a state-bound handoff before redemption. Sign-in methods and account management redirect to Identity.

Every authenticated request introspects current Identity session and membership state. Outages fail closed; central revocation takes effect on the next request. SUPER_ADMIN comes only from the verified central session flag. The central selected tenant and an untrusted business-number preference are checked against current enabled membership and reviewed immutable number mappings on every request. Several mapped numbers may belong to one tenant. No arbitrary number selection or local role override exists. The business picker is available to every user.

Browser mutations require an Origin matching `APP_BASE_URL`. Messaging proxies inject the authorized number after any input body and remove browser authentication headers from multipart forwarding. Carrier administration is SUPER_ADMIN-only for this POC; ordinary account settings redirect to Identity. Tenant-specific carrier credential management remains a later bounded change.

Number reassignment is unsupported until historical message/media ownership is independently modeled. A changed source organization number fails closed against its captured mapping. Raw EchoService and EchoMedia endpoints remain their existing trust boundary; do not expose those legacy APIs as authenticated multi-tenant services merely because this browser now checks memberships. This PR does not remediate public media URLs or rework carrier callbacks.

## Validation

`docker build --target test -t echo-web-platform:test .` runs typecheck/build plus the cookie, handoff, tenant/proxy authorization and scoped-settings tests. The integration suite needs disposable MySQL and a read-only EchoDatabase checkout mounted beneath `/app/schema`:

```sh
docker run --rm --network platform-test \
  --mount type=bind,src=/absolute/EchoDatabase,dst=/app/schema,readonly \
  -e ECHO_DATABASE_SOURCE=/app/schema \
  -e TEST_DB_URL=mysql://root:test-password@mysql:3306/echo_platform_test \
  echo-web-platform:test npm test -- src/platform.integration.test.ts
```

It recreates only `echo_platform_test`; never point it at a production server. The suite executes the actual SQL migration twice and the actual dry-run/apply importer, verifies preserved history, separate tenant access, several numbers per tenant, rejected remappings and mapping drift. Live SMS/MMS/carrier and browser proxy acceptance remain deployment checks, not claims made by these isolated tests.

`IDENTITY_BASE_URL` is the server API origin (for example, `http://identity-preview:3200`). Set optional `IDENTITY_PUBLIC_BASE_URL` to the browser-facing HTTPS origin when Docker DNS differs from public DNS; it defaults to `IDENTITY_BASE_URL`. Token exchange, session checks and tenant selection always use the internal API origin.

Set `MEDIA_INTERNAL_BASE_URL` to the private EchoMedia origin (for example, `http://echo-media-preview:8082`) to serve attachments through `/api/media/<stored-path>`. The browser receives only that same-origin route. Each image, thumbnail, draft or range request rechecks the central session and selected business, then verifies exact stored-path ownership in Echo's message/draft tables before streaming. Keep EchoMedia on a private network without a public proxy. Responses are private and uncached; active content downloads as an attachment. If the internal origin is unset, legacy `MEDIA_BASE_URL` behavior remains available during migration.
