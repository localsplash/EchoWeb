// Exercise the identity-management and super-admin endpoints against the
// running dev stack, including the authorization boundaries.
const crypto = require('crypto');
const { BASE, db, ssoSecret, crmKey, crmBase, mysql } = require('./env');

const SECRET = ssoSecret();
const DB = db();

function ssoUrl(clientId) {
  const payload = JSON.stringify({
    clientId: String(clientId),
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + 30,
  });
  const code = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(code).digest('hex');
  return `${BASE}/sso/callback?code=${encodeURIComponent(code)}&sig=${sig}`;
}

async function signInViaBridge(clientId) {
  const r = await fetch(ssoUrl(clientId), { redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : null;
}

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok, extra });

(async () => {
  const db = await mysql.createConnection(DB);

  // Sign in as the org owner for CRM client 369 (Wisp / 7146403939)
  const owner = await signInViaBridge('369');
  if (!owner) throw new Error('bridge sign-in failed');

  const [[me]] = [await (await fetch(`${BASE}/api/me`, { headers:{Cookie:owner} })).json()].map(x => [x]);
  const iUserId = me.iUserId;

  // ── list own identities ───────────────────────────────────────────────────
  let r = await fetch(`${BASE}/api/identities`, { headers: { Cookie: owner } });
  let body = await r.json();
  const uisp = body.items.find(i => i.provider === 'uisp');
  check('lists own identities', r.status === 200 && body.items.length >= 1);
  check('uisp identity is present', !!uisp);
  check('uisp identity is not removable', uisp && uisp.removable === false);
  check('uisp identity carries a readable label', !!(uisp && uisp.label));

  // ── unauthenticated access ────────────────────────────────────────────────
  r = await fetch(`${BASE}/api/identities`);
  check('identities require a session (401)', r.status === 401);

  // ── cannot unlink the ISP binding ─────────────────────────────────────────
  r = await fetch(`${BASE}/api/identities/${uisp.iIdentityId}`, {
    method: 'DELETE', headers: { Cookie: owner } });
  body = await r.json();
  check('refuses to unlink the uisp identity', r.status === 400, body.error);

  // ── cannot unlink the only identity ───────────────────────────────────────
  // Seed a second user holding a single google identity.
  const [ins] = await db.query(
    `INSERT INTO auth_tbl_User (email, displayName) VALUES ('solo@example.com','Solo User')`);
  const soloId = ins.insertId;
  await db.query(
    `INSERT INTO auth_tbl_Identity (iUserId, provider, subject, email)
     VALUES (?, 'google', ?, 'solo@example.com')`, [soloId, 'sub-solo-' + Date.now()]);
  const [[soloIdent]] = await db.query(
    `SELECT iIdentityId FROM auth_tbl_Identity WHERE iUserId = ?`, [soloId]);

  // ── super-admin boundary ──────────────────────────────────────────────────
  r = await fetch(`${BASE}/api/admin/accounts`, { headers: { Cookie: owner } });
  check('non-superadmin cannot read admin overview (403)', r.status === 403);

  r = await fetch(`${BASE}/api/admin/identities/${soloIdent.iIdentityId}`, {
    method: 'DELETE', headers: { Cookie: owner } });
  check('non-superadmin cannot unlink via admin route (403)', r.status === 403);

  r = await fetch(`${BASE}/internal/accounts`, { headers: { Cookie: owner }, redirect: 'manual' });
  check('non-superadmin redirected away from admin page', r.status === 302);

  // ── cross-account isolation ───────────────────────────────────────────────
  r = await fetch(`${BASE}/api/identities/${soloIdent.iIdentityId}`, {
    method: 'DELETE', headers: { Cookie: owner } });
  check("cannot unlink another user's identity (404)", r.status === 404);
  const [[stillThere]] = await db.query(
    `SELECT COUNT(*) n FROM auth_tbl_Identity WHERE iIdentityId = ?`, [soloIdent.iIdentityId]);
  check("other user's identity survived the attempt", Number(stillThere.n) === 1);

  // ── super-admin can read, and last-identity floor still applies ───────────
  const admin = await (async () => {
    // Mint a super-admin session directly; the Google round trip can't be scripted.
    const sid = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO auth_tbl_Session (sSessionId, iUserId, bIsSuperAdmin, dtExpires)
       VALUES (?, ?, 1, DATE_ADD(NOW(3), INTERVAL 1 HOUR))`, [sid, iUserId]);
    return `echo_session=${sid}`;
  })();

  r = await fetch(`${BASE}/api/admin/accounts`, { headers: { Cookie: admin } });
  body = await r.json();
  check('superadmin can read admin overview', r.status === 200 && Array.isArray(body.items));

  const orgView = body.items.find(o => o.uispClientId === '369');
  check('overview includes the org with its number', !!orgView && orgView.iBusinessNumber === 7146403939);
  check('overview nests users under the org', !!orgView && orgView.users.length >= 1);
  check('overview nests identities under the user',
        !!orgView && orgView.users.some(u => u.identities.length >= 1));

  const orphanView = body.items.find(o => o.iOrgId === null);
  check('orphaned users are surfaced', !!orphanView && orphanView.users.some(u => u.iUserId === soloId));

  r = await fetch(`${BASE}/api/admin/identities/${soloIdent.iIdentityId}`, {
    method: 'DELETE', headers: { Cookie: admin } });
  body = await r.json();
  check('superadmin refused when it is the last identity', r.status === 400, body.error);

  // Give the solo user a second identity, then the unlink should be allowed.
  await db.query(
    `INSERT INTO auth_tbl_Identity (iUserId, provider, subject, email)
     VALUES (?, 'google', ?, 'solo2@example.com')`, [soloId, 'sub-solo2-' + Date.now()]);
  r = await fetch(`${BASE}/api/admin/identities/${soloIdent.iIdentityId}`, {
    method: 'DELETE', headers: { Cookie: admin } });
  check('superadmin can unlink when another remains', r.status === 200);

  // ── cleanup ───────────────────────────────────────────────────────────────
  await db.query(`DELETE FROM auth_tbl_User WHERE iUserId = ?`, [soloId]);
  await db.query(`DELETE FROM auth_tbl_Session WHERE sSessionId = ?`, [admin.split('=')[1]]);
  await db.end();

  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  [${r.extra}]` : ''}`);
  }
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
