# Manual tests

These run against a **live stack**. They are not unit tests and are
deliberately excluded from `npm test` — they mutate real rows and call
external APIs.

Sign-in, identities, and the UISP SSO bridge moved to the `id` app
(id.<parent-domain>); their manual tests moved with them. What remains here
is Echo-specific surface only.

Credentials come from the environment; nothing is hardcoded. Source the
orchestrator env first:

```bash
set -a; . /opt/echo/EchoOrchestrator/.env; set +a
cd /opt/echo/EchoWeb/scripts/manual-tests

node env.js               # sanity-check the environment wiring
```
