# Manual tests

The former `identity.js` and `crm-match.js` scripts were removed with Echo's
local authentication tables. Identity now owns authentication and tenant-number
access; the old direct-SQL session fixtures are no longer valid.

`sso-bridge.js` is a historical UISP bridge diagnostic. Review its expected
routes against the current Identity flow before using it. For current central
session/tenant boundaries use `npm test`; for the destructive Dev schema test
provide an isolated MySQL server through `TEST_DB_URL` and the matching
`ECHO_DATABASE_SOURCE` checkout as described in the repository README.
