# EchoWeb

Echo's messaging browser and backend-for-frontend. Identity owns users, businesses, memberships and browser sessions; EchoService owns messaging operations; EchoDatabase owns messaging and media records. This app reads messaging/media ownership from MySQL and sends messaging operations through `ECHO_SERVICE_BASE_URL`.

## Development and configuration

Use Node 22: `npm ci`, then `npm run dev`. EchoWeb does not load `.env` itself; export its values or pass them through Docker Compose. Copy `.env.example` for the NocoDB bootstrap credentials; configure Echo database coordinates in PlatformConfig.

The only runtime settings source is `PlatformConfig/cfg_tbl_Setting` through NocoDB. Resolution is exact `echo-web`, declared parent `echo`, then global `*`, with URL defaults derived from `PARENT_DOMAIN`. Blank seeded rows are unset; duplicate bases, tables and scoped keys fail. Runtime reads never create configuration. Settings and resolved IDs refresh every 30 seconds; failures return 503. `/healthz` remains configuration independent. Coordinate changes require restart.

Required application settings are `PARENT_DOMAIN` and, where service network trust needs it, `IDENTITY_CLIENT_SECRET`. Public defaults derive from the whitelabel domain: `https://echo.X.TLD` and `https://identity.X.TLD`. A row pins a URL explicitly where the derived default is wrong. EchoMedia has no public hostname: it is reached only through this app's authorized `/media` route. No provider OAuth credentials belong in EchoWeb.

Addresses of sibling containers are not settings. `ECHO_SERVICE_BASE_URL` and `MEDIA_INTERNAL_BASE_URL` are process environment with defaults (`http://echo-service-private:8080`, `http://echo-media:8082`) matching the standard Compose stack. EchoService registers `echo-service-private` only on the private network. Use that name for internal calls: when both services also join the proxy network, the ordinary `echo-service` name can resolve to the proxy address and trigger a network-policy rejection. Override the addresses where the network names differ, as in a preview environment.

Provide service-owned `NOCODB_BASE_URL` and `NOCODB_API_TOKEN` directly in the
deployment environment. The legacy SQL/IdentityBase readers, settings-mode
switch and optional Identity bootstrap-file reader have been removed.

## Deployment ownership

Environments include this repository's `compose.yaml`; `docker-compose.yml`
is a standalone development example. The includable file joins existing
`ECHO_NETWORK` and `ECHO_PROXY_NETWORK` networks and publishes no host port.
NPM forwards `echo.X.TLD` to `echo-web:3160`; see
[`deploy/nginx/echo.X.TLD.conf`](deploy/nginx/echo.X.TLD.conf). Public Identity
calls use `https://identity.X.TLD`. EchoService and EchoMedia use private names.

An environment is a copy of [`deploy/environment`](deploy/environment) with
the four checkouts (EchoWeb, EchoService, EchoMedia, EchoDatabase) cloned inside
it and `.env` filled from the example — on the dev host that folder is
`/opt/local/echo`. Its `compose.yaml` includes each repo's deployment and gates
the applications on EchoDatabase's migration/account jobs; existing data
volumes stay external. `.env` holds only bootstrap and Docker wiring: the shared
`NOCODB_BASE_URL`, one prefixed NocoDB token per application, and the MySQL
account passwords EchoDatabase's jobs create. `deploy.sh` stamps each image
with its own checkout's commit (`ECHO_WEB_REVISION/EPOCH/DIRTY` and so on); the
single-repo `BUILD_*` fallback must not be reused across an included
multi-repo build.

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and secret `DB_PASSWORD` resolve from
PlatformConfig (`*` < `echo` < `echo-web`); same-named environment variables are
ignored. Without DB_HOST the app derives `lsdb.<PARENT_DOMAIN>`; DB_PORT defaults
to 3306. Use the separate read-only `echo_web` account, with its credentials in
`echo-web` scope. Set DB_NAME explicitly. The pool opens on first use and retains
its coordinates until restart. `/readyz` returns 503 with `database_unconfigured`
for missing/invalid coordinates and `database_unreachable` for connection/query
failure. `/healthz` stays independent. EchoDatabase's operator jobs take admin
credentials separately; never put the MySQL admin password in PlatformConfig.

## Public and private APIs

`https://echo.X.TLD/api/...` is EchoWeb's browser API. It validates the central
Identity session, tenant/number authorization and same-origin mutations before
forwarding messaging requests to EchoService's private, unversioned `/api`.
Carrier administration additionally requires SUPER_ADMIN. EchoWeb injects the
authorized business number rather than trusting the browser to choose one.
EchoService's API has no browser session boundary: `trustedCIDR` restricts who
can call it, so it must stay private. Carrier ingress alone uses
`https://echo-webhook.X.TLD/v1/{bandwidth,tychron}/...` and webhook authentication.
EchoMedia has no public hostname; `/media/...` here checks session and ownership
before streaming from the private media origin.

## Central-session cutover

Identity owns users, tenants, memberships, central sessions and tenant-number
assignments. Echo no longer needs local auth/provenance tables or a mapping
import before accepting a central session. The disposable Dev cleanup removes
those obsolete tables with EchoDatabase migration 013 while retaining active
messaging/media records.

The browser exchanges a state-bound Identity code and receives an opaque central application token in `__Host-echo_platform_session` (Secure, HttpOnly, SameSite=Lax). The old `echo_session` cookie is ignored and cleared during the new login/logout; existing users authenticate through the preserved central SSO account. An unsolicited UISP/Identity entry starts a state-bound handoff before redemption. Sign-in methods and account management redirect to Identity.

Every authenticated request introspects current Identity session and membership state. Outages fail closed; central revocation takes effect on the next request. SUPER_ADMIN comes only from the verified central session flag. The central selected tenant and an untrusted business-number preference are checked against current enabled membership and current Identity number assignments on every request. Several mapped numbers may belong to one tenant. No arbitrary number selection or local role override exists. The business picker is available to every user.

Browser mutations require an Origin matching `APP_BASE_URL`. Messaging proxies inject the authorized number after any input body and remove browser authentication headers from multipart forwarding. Carrier administration is SUPER_ADMIN-only for this POC; ordinary account settings redirect to Identity. Tenant-specific carrier credential management remains a later bounded change.

Number reassignment is unsupported until historical message/media ownership is independently modeled. Current Identity number assignments are the only number authority. Raw EchoService and EchoMedia endpoints remain their existing trust boundary; do not expose those legacy APIs as authenticated multi-tenant services merely because this browser now checks memberships. This PR does not remediate public media URLs or rework carrier callbacks.

## Validation

`docker build --target test -t echo-web-platform:test .` runs typecheck/build plus the cookie, handoff, tenant/proxy authorization and scoped-settings tests. The integration suite needs disposable MySQL and a read-only EchoDatabase checkout mounted beneath `/app/schema`:

```sh
docker run --rm --network platform-test \
  --mount type=bind,src=/absolute/EchoDatabase,dst=/app/schema,readonly \
  -e ECHO_DATABASE_SOURCE=/app/schema \
  -e TEST_DB_URL=mysql://root:test-password@mysql:3306/echo_platform_test \
  echo-web-platform:test npm test -- src/platform.integration.test.ts
```

It recreates only `echo_platform_test` on an isolated test server. The suite runs
the full current fresh schema, executes a messaging routine, then creates
populated legacy fixtures and applies migration 013 twice. It verifies that the
nine retired tables disappear, messaging and ledger rows remain, and current
Identity session authorization works without local auth/mapping tables. Live
carrier and browser acceptance remain deployment checks.

`IDENTITY_BASE_URL` is the public Identity API origin (normally `https://identity.X.TLD`). Server calls use that public name through the deployment proxy. `IDENTITY_PUBLIC_BASE_URL` defaults to it and can explicitly name a different browser origin in PlatformConfig.

`MEDIA_INTERNAL_BASE_URL` is the private EchoMedia origin, defaulting to `http://echo-media:8082` and overridable where the service name differs (for example, `http://echo-media-preview:8082`). Attachments are served through `/media/<stored-path>`; the browser receives only that same-origin route and never the private origin. Each image, thumbnail, draft or range request rechecks the central session and selected business, then verifies exact stored-path ownership in Echo's message/draft tables before streaming. Keep EchoMedia on a private network without a public proxy. Responses are private and uncached; active content downloads as an attachment.

The former public-media fallback and its `MEDIA_BASE_URL` setting are gone, so an origin explicitly blanked now fails at startup rather than quietly serving attachments from an unauthenticated public host.

## Shared tenant numbers and SSO

Deploy Identity migration `0005_shared_phone_numbers` first and backfill reviewed tenant-number assignments. Echo now requires the `numbers` field in central session introspection and does not query `echo_tbl_PlatformOrgMap` to authorize users. The obsolete mapping tables and importer are removed. Active message/media IDs and data stay in EchoDatabase.

Manage numbers and memberships together in AidaAdmin. Every enabled tenant member (including USER) inherits the explicit `TENANT_MEMBERS` number policy. A member can sign in without numbers and receives a message to contact their Tenant Admin. Multiple numbers are supported; selection remains tenant-scoped and revalidated on every request. `iOrgId` in `/api/me` is now nullable metadata.

Opening Echo automatically starts the state-bound Identity handoff. An existing Identity SSO session completes it without another provider login. Each application retains its own secure cookie. Explicit Echo logout stays on the signed-out page; selecting sign-in can reuse Identity SSO again. Check both the proxy manager’s saved upstream and generated configuration when switching from an older Echo container.

## Disposable Dev retirement

This Dev deployment intentionally discards obsolete settings, local authentication
and provenance objects. There is no legacy settings mode, rollback copy or
preservation window. Deploy the matching EchoWeb/EchoService revisions and then
apply EchoDatabase `013_retire_legacy_configuration_and_auth.sql`. Fresh schema
initialization no longer creates the retired tables.

Validate service-owned PlatformConfig credentials, central sign-in, tenant/number
selection, SMS/MMS, settings refresh/failure/recovery, and private authenticated
media access. Use `MEDIA_INTERNAL_BASE_URL`, reject cross-tenant paths, and remove
public upstream access to raw EchoMedia. Record actual deployed versions and
results in the deployment PR or issue in this repository.
A code merge alone is not deployment evidence.

PBX extensions, queues, queue membership and operational state belong to
Asterisk/OfficePulse. Business/tenant administration belongs to Identity/AidaAdmin.
Echo does not track PBX provisioning replicas or synchronization status.
AidaAgent/AidaHandset remain outside this work.

## Health version and Pacific timezone

The liveness response includes `version` (`YYYY.M.D.H.M`), full Git `revision`,
`sourceUpdatedAt` (ISO 8601 with Pacific offset), `timeZone` (`America/Los_Angeles`),
and `dirty`. Existing status fields and readiness behavior are preserved.
`GET /healthz` stays independent of authentication and external dependencies.

Versions use HEAD's committer timestamp in Pacific time (PST/PDT), never build time.
For example, `2026-09-14T21:30:42Z` becomes `2026.9.14.14.30` and
`sourceUpdatedAt: "2026-09-14T14:30:42-07:00"`. The clock belongs to the machine
creating the commit, including GitHub for web-created commits. Rebuilding a commit
preserves its version. Same-minute commits and the repeated autumn DST hour are
distinguished by `revision`; dates alone are not a monotonic sequence.

`npm run build` embeds identity in the artifact. Uncommitted/staged/untracked changes
append `-dirty`; commit before building releases. Unbuilt source development reports
`unbuilt` with null revision fields. Package and API contract versions stay separate.
Runtime `TZ` defaults to `America/Los_Angeles` and may be overridden explicitly;
version formatting always stays Pacific. Docker includes timezone data. Explicit UTC
storage/protocol timestamp contracts remain UTC to preserve existing data semantics.

Docker/source archive builds require all three values: `BUILD_REVISION` (full SHA),
`SOURCE_DATE_EPOCH` (Git committer epoch), and `BUILD_DIRTY` (`true` or `false`).
Missing or malformed identity fails the build. The wrapper derives them from Git:

```sh
scripts/with-build-info.sh sh -c 'docker build \
  --build-arg BUILD_REVISION --build-arg SOURCE_DATE_EPOCH --build-arg BUILD_DIRTY \
  -t echoweb:local .'
scripts/with-build-info.sh docker compose up -d --build

```

External orchestrators building this Dockerfile must forward these same build args.
No runtime Git checkout or version environment override is needed.
