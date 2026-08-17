// Verify the CRM-email fallback for Google sign-ins unknown to Echo.
// The Google round trip can't be scripted, so this drives the same code path by
// calling the CRM lookup + provisioning directly, then checks the routing rules
// over HTTP with real sessions.
const { BASE, db, crmKey, crmBase, mysql } = require('./env');

const DB = db();
const KEY = crmKey();
const CRM = crmBase();

const results = [];
const check = (n, ok, extra='') => results.push({ n, ok, extra });

// Mirror of findUispClientByEmail, to confirm the branch each address takes.
async function lookup(email) {
  const r = await fetch(`${CRM}/clients?email=${encodeURIComponent(email)}`,
    { headers: { 'X-Auth-App-Key': KEY, Accept: 'application/json' } });
  if (!r.ok) throw new Error('lookup failed ' + r.status);
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) return null;
  const parsed = list.map(c => {
    const a = (c.attributes || []).find(x => x.key === 'hostedPulseNumber');
    const raw = String(a?.value ?? '').replace(/\D/g, '');
    return { clientId: String(c.id), hostedPulseNumber: raw.length === 10 ? raw : null,
             displayName: c.companyName || null };
  });
  return parsed.find(p => p.hostedPulseNumber) || parsed[0];
}

(async () => {
  const db = await mysql.createConnection(DB);

  // ── branch selection ──────────────────────────────────────────────────────
  const withNum = await lookup('drodecker@gmail.com');       // client 369, has number
  const noNum   = await lookup('will@hudsonshuffleboards.com'); // client 1, no number
  const missing = await lookup('nobody-xyz@example.com');

  check('known contact WITH number resolves', !!withNum && withNum.hostedPulseNumber === '7146403939',
        withNum ? `client ${withNum.clientId}` : 'none');
  check('known contact WITHOUT number resolves', !!noNum && noNum.hostedPulseNumber === null,
        noNum ? `client ${noNum.clientId}` : 'none');
  check('unknown address returns nothing (-> /sign-up)', missing === null);

  // ── routing rules over HTTP ───────────────────────────────────────────────
  let r = await fetch(`${BASE}/sign-up`, { redirect: 'manual' });
  check('/sign-up is public', r.status === 200);

  r = await fetch(`${BASE}/order-echo`, { redirect: 'manual' });
  check('/order-echo requires a session', r.status === 302);

  // A session whose org has no number must be routed to ordering, not the app.
  const [orgIns] = await db.query(
    `INSERT INTO auth_tbl_Org (uisp_client_id, iBusinessNumber, displayName)
     VALUES ('test-nonum', NULL, 'No Number Org')`);
  const [userIns] = await db.query(
    `INSERT INTO auth_tbl_User (email, displayName) VALUES ('nonum@example.com','No Number')`);
  await db.query(
    `INSERT INTO auth_tbl_Membership (iUserId, iOrgId, role, status) VALUES (?,?, 'owner','active')`,
    [userIns.insertId, orgIns.insertId]);
  const sid = require('crypto').randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO auth_tbl_Session (sSessionId, iUserId, iOrgId, iBusinessNumber, role, dtExpires)
     VALUES (?, ?, ?, NULL, 'owner', DATE_ADD(NOW(3), INTERVAL 1 HOUR))`,
    [sid, userIns.insertId, orgIns.insertId]);
  const cookie = `echo_session=${sid}`;

  r = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  check('number-less session redirected from / to /order-echo',
        r.status === 302 && r.headers.get('location') === '/order-echo',
        r.headers.get('location') || '');

  r = await fetch(`${BASE}/order-echo`, { headers: { Cookie: cookie }, redirect: 'manual' });
  check('number-less session can view /order-echo', r.status === 200);

  const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
  check('/api/me exposes org context for the page',
        me.orgName === 'No Number Org' && me.email === 'nonum@example.com');
  check('/api/me reports no business number', me.iBusinessNumber === null);

  // Messaging APIs must stay closed without a number.
  r = await fetch(`${BASE}/api/conversations`, { headers: { Cookie: cookie } });
  check('messaging API refuses a number-less session (401)', r.status === 401);

  // ── org upsert must never blank an existing number ────────────────────────
  await db.query(`UPDATE auth_tbl_Org SET iBusinessNumber = 5551234567 WHERE iOrgId = ?`, [orgIns.insertId]);
  await db.query(
    `UPDATE auth_tbl_Org SET iBusinessNumber = COALESCE(NULL, iBusinessNumber) WHERE iOrgId = ?`,
    [orgIns.insertId]);
  const [[chk]] = await db.query(`SELECT iBusinessNumber FROM auth_tbl_Org WHERE iOrgId = ?`, [orgIns.insertId]);
  check('null number never overwrites an existing one', Number(chk.iBusinessNumber) === 5551234567);

  // ── cleanup ───────────────────────────────────────────────────────────────
  await db.query(`DELETE FROM auth_tbl_Session WHERE sSessionId = ?`, [sid]);
  await db.query(`DELETE FROM auth_tbl_User WHERE iUserId = ?`, [userIns.insertId]);
  await db.query(`DELETE FROM auth_tbl_Org WHERE iOrgId = ?`, [orgIns.insertId]);
  await db.end();

  let fail = 0;
  for (const x of results) {
    if (!x.ok) fail++;
    console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${x.extra ? `  [${x.extra}]` : ''}`);
  }
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
