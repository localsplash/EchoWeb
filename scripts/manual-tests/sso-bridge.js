// Simulate the UISP bridge: sign a code exactly as public.php does, hit
// /sso/callback, and assert the user lands logged in rather than at a gate.
const crypto = require('crypto');
const { BASE, ssoSecret } = require('./env');
const SECRET = ssoSecret();

function sign(clientId) {
  const payload = JSON.stringify({
    clientId: String(clientId),
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + 30,
  });
  const code = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(code).digest('hex');
  return { code, sig };
}

async function hit(label, code, sig) {
  const r = await fetch(`${BASE}/sso/callback?code=${encodeURIComponent(code)}&sig=${encodeURIComponent(sig)}`, {
    redirect: 'manual',
  });
  const loc = r.headers.get('location');
  const cookie = r.headers.get('set-cookie');
  console.log(`${label}`);
  console.log(`   status   : ${r.status}`);
  console.log(`   redirect : ${loc ?? '(none — page body returned)'}`);
  console.log(`   session  : ${cookie ? 'SET' : 'none'}`);
  return { status: r.status, loc, cookie };
}

(async () => {
  const CLIENT = process.env.TEST_CLIENT_ID || '1';

  // 1. First entry for this client
  const a = sign(CLIENT);
  const r1 = await hit(`1) First bridge entry (client ${CLIENT})`, a.code, a.sig);

  // 2. Replay the exact same code — must be rejected
  const r2 = await hit('2) Replay of the same code', a.code, a.sig);

  // 3. Fresh code, same client — should be a return login, not a new account
  const b = sign(CLIENT);
  const r3 = await hit(`3) Return entry (fresh code, same client)`, b.code, b.sig);

  // 4. Tampered signature
  const c = sign(CLIENT);
  const r4 = await hit('4) Tampered signature', c.code, 'de: ad'.replace(/\W/g, '') .padEnd(64, '0'));

  console.log('\n--- assertions ---');
  const chk = (name, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  chk('first entry issues a session', !!r1.cookie);
  chk('first entry goes to /welcome (optional linking)', r1.loc === '/welcome');
  chk('replay rejected', /sso_replay/.test(r2.loc || ''));
  chk('return entry issues a session', !!r3.cookie);
  chk('return entry goes straight to app', r3.loc === '/');
  chk('bad signature rejected', /invalid_sso_code/.test(r4.loc || ''));
})();
