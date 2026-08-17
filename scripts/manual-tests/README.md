# Manual tests

These run against a **live stack** (EchoWeb + database + the UISP CRM). They are
not unit tests and are deliberately excluded from `npm test` — they mutate real
rows and call the CRM API.

Credentials come from the environment; nothing is hardcoded. Source the
orchestrator env first:

```bash
set -a; . /opt/echo/EchoOrchestrator/.env; set +a
cd /opt/echo/EchoWeb/scripts/manual-tests

node sso-bridge.js        # UISP bridge: signing, replay, first vs return entry
node identity.js          # sign-in methods + super-admin overview, incl. authz boundaries
node crm-match.js         # Google sign-in matched against a CRM contact email
```

Optional overrides: `ECHO_BASE_URL` (default `http://127.0.0.1:3160`),
`DB_HOST_LOCAL` / `DB_PORT_LOCAL` (default `127.0.0.1:13306`, the published port).

## Notes

- `sso-bridge.js` takes `TEST_CLIENT_ID` (default `1`). Its "first entry" case
  only passes for a CRM client that has **no org in Echo yet** — once provisioned
  that client correctly returns to `/` instead of `/welcome`. Pick an
  unprovisioned client id with a `hostedPulseNumber` set.
- `identity.js` and `crm-match.js` create and then delete their own fixtures.
- `crm-match.js` reads real CRM clients; it does not write to UISP.
