import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { loadConfig } from './config';
import { getDb } from './db';
import {
  getSessionIdFromRequest,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  deleteSession,
  updateSessionBusinessNumber,
  buildGoogleAuthUrl,
  buildMicrosoftAuthUrl,
  setOAuthStateCookie,
  clearOAuthStateCookie,
  getOAuthStateFromRequest,
  exchangeGoogleCode,
  getGoogleUserInfo,
  exchangeMicrosoftCode,
  parseMicrosoftIdToken,
  verifySsoCode,
  consumeNonce,
  fetchUispClient,
  findUispClientByEmail,
  upsertOrg,
  findUserByIdentity,
  findUserByEmail,
  createUser,
  ensureIdentity,
  createMembership,
  getOwnerMembership,
  listIdentities,
  getIdentity,
  deleteIdentity,
  countIdentities,
  adminListAccounts,
  createSuperAdminSession,
  createFullSession,
  generateId,
  type SessionRow,
  type OAuthState,
  type OAuthProvider,
  type OAuthUserInfo,
} from './auth';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const publicDir = path.join(__dirname, '..', 'public');

// ─── Session resolution ───────────────────────────────────────────────────────

async function resolveSession(req: express.Request): Promise<SessionRow | null> {
  const config = loadConfig();
  const db = getDb(config);
  const id = getSessionIdFromRequest(req);
  if (!id) return null;
  return getSession(db, id);
}

// ─── Proxy helpers ────────────────────────────────────────────────────────────

// Proxy that does NOT inject businessNumber — used for settings endpoints.
async function proxyDirect(
  config: ReturnType<typeof loadConfig>,
  session: SessionRow | null,
  targetPath: string,
  method: ApiMethod,
  body?: unknown
) {
  if (!session?.iBusinessNumber && !session?.bIsSuperAdmin) {
    return { status: 401, data: { error: 'Not logged in' } };
  }

  const url = new URL(targetPath, config.ECHO_SERVICE_BASE_URL);
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await response
    .json()
    .catch(() => ({ error: 'Invalid response from EchoService' }));
  return { status: response.status, data };
}

async function proxyEchoService(
  config: ReturnType<typeof loadConfig>,
  session: SessionRow | null,
  reqPath: string,
  method: ApiMethod,
  body?: unknown
) {
  const business = session?.iBusinessNumber;
  if (!business) return { status: 401, data: { error: 'Not logged in' } };

  const url = new URL(reqPath, config.ECHO_SERVICE_BASE_URL);
  if (method === 'GET' || method === 'DELETE')
    url.searchParams.set('businessNumber', String(business));

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body:
      method === 'GET'
        ? undefined
        : JSON.stringify({
            businessNumber: business,
            ...(body && typeof body === 'object' ? body : {}),
          }),
  });

  const data = await response
    .json()
    .catch(() => ({ error: 'Invalid response from EchoService' }));
  return { status: response.status, data };
}

// ─── Shared provisioning ──────────────────────────────────────────────────────

/**
 * Resolve (or create) the org and owner for a CRM client, then attach the
 * identity that got us here.
 *
 * Shared by the UISP bridge and by Google sign-in that matched a CRM contact
 * address, so both routes agree on one rule: one org per CRM client, one owner
 * per org. If the org already has an owner, the incoming identity is attached to
 * that user rather than minting a rival owner.
 */
async function provisionFromCrmClient(
  db: ReturnType<typeof getDb>,
  params: {
    clientId: string;
    iBusinessNumber: number | null;
    displayName: string | null;
    contactEmail: string | null;
    identity: { provider: 'uisp' | 'google' | 'microsoft'; subject: string; email: string | null };
  }
): Promise<{ iOrgId: number; iUserId: number; isFirstEntry: boolean }> {
  const { iOrgId } = await upsertOrg(
    db,
    params.clientId,
    params.iBusinessNumber,
    params.displayName
  );

  let iUserId = await findUserByIdentity(db, params.identity.provider, params.identity.subject);
  let isFirstEntry = false;

  if (!iUserId) {
    const existingOwner = await getOwnerMembership(db, iOrgId);
    if (existingOwner) iUserId = existingOwner.iUserId;
  }

  if (!iUserId) {
    iUserId = await createUser(
      db,
      params.identity.email ?? params.contactEmail,
      params.displayName
    );
    await createMembership(db, iUserId, iOrgId, 'owner');
    isFirstEntry = true;
  }

  await ensureIdentity(
    db,
    iUserId,
    params.identity.provider,
    params.identity.subject,
    params.identity.email ?? params.contactEmail
  );

  return { iOrgId, iUserId, isFirstEntry };
}

// ─── App builder ──────────────────────────────────────────────────────────────

export function buildApp() {
  const config = loadConfig();
  const db = getDb(config);
  const logger = pino({ level: config.LOG_LEVEL });
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(pinoHttp({ logger }));
  app.use(express.static(publicDir, { index: false }));

  // Browser config (media URL, UISP plugin URL, which logins are available).
  const configJs = `window.ECHO_CONFIG=${JSON.stringify({
    MEDIA_BASE_URL: config.MEDIA_BASE_URL,
    UISP_PLUGIN_URL: config.UISP_PLUGIN_URL,
    // Only the flag — never the client id, which the browser has no use for.
    MICROSOFT_ENABLED: Boolean(config.MICROSOFT_CLIENT_ID),
  })};`;
  app.get('/config.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(configJs);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'EchoWeb' });
  });

  // ── Root / login guard ───────────────────────────────────────────────────────

  app.get('/', async (req, res) => {
    const session = await resolveSession(req);
    if (!session) {
      return res.sendFile(path.join(publicDir, 'login.html'));
    }
    if (session.bIsSuperAdmin && !session.iBusinessNumber) {
      // Super-admin has not yet selected a business phone
      return res.redirect('/internal');
    }
    if (!session.iBusinessNumber) {
      // A real account whose org has no number yet — the messaging UI would be
      // an empty shell and every API call would 401, so route them to ordering.
      return res.redirect('/order-echo');
    }
    return res.sendFile(path.join(publicDir, 'index.html'));
  });

  // ── Placeholder sub-applications ─────────────────────────────────────────────
  // Stubs only — these will become their own apps.

  app.get('/sign-up', (_req, res) => {
    res.sendFile(path.join(publicDir, 'sign-up.html'));
  });

  app.get('/order-echo', async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.iUserId) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'order-echo.html'));
  });

  // ── OAuth sign-in (Google, Microsoft) ────────────────────────────────────────

  /**
   * A wisp.net address is what grants super-admin, so it has to mean something.
   * Google vouches for the Workspace domain it reports. Entra does not: with a
   * 'common' authority the address in the token is whatever the user's own
   * tenant put there, so any directory could mint one. Microsoft tokens
   * therefore only reach this branch when they came from Wisp's own directory.
   */
  function isWispStaff(provider: OAuthProvider, userInfo: OAuthUserInfo): boolean {
    const wispAddress =
      userInfo.email?.toLowerCase().endsWith('@wisp.net') || userInfo.hd === 'wisp.net';
    if (!wispAddress) return false;
    if (provider === 'microsoft') {
      return userInfo.tenantId === config.MICROSOFT_WISP_TENANT_ID;
    }
    return true;
  }

  /**
   * Validate the returned OAuth state against the cookie we set before leaving.
   * Returns an error path on failure so callers stay a straight line.
   */
  function checkOAuthState(
    req: express.Request,
    provider: OAuthProvider
  ): { state: OAuthState } | { error: string } {
    const stored = getOAuthStateFromRequest(req);
    if (!stored) return { error: '/?auth_error=invalid_state' };

    // Both providers share one state cookie. Refusing a state minted for the
    // other keeps an abandoned "link Google" attempt from turning a later
    // Microsoft sign-in into a link against that stale session.
    if (stored.provider !== provider) return { error: '/?auth_error=invalid_state' };

    let returned: OAuthState;
    try {
      returned = JSON.parse(
        Buffer.from(String(req.query.state ?? ''), 'base64url').toString('utf8')
      ) as OAuthState;
    } catch {
      return { error: '/?auth_error=invalid_state' };
    }
    if (stored.csrf !== returned.csrf) return { error: '/?auth_error=csrf_mismatch' };

    return { state: stored };
  }

  /**
   * Everything that happens once a provider has told us who the user is.
   *
   * Google and Microsoft differ only in how the identity is obtained, so the
   * super-admin, link and login branches live here rather than once per
   * provider — one set of rules about who gets an account and who owns an org.
   *
   * Sets the session cookie as a side effect; returns where to send the user.
   */
  async function completeOAuthLogin(
    res: express.Response,
    provider: OAuthProvider,
    userInfo: OAuthUserInfo,
    storedState: OAuthState
  ): Promise<string> {
    // ── Super-admin path ───────────────────────────────────────────────────
    if (isWispStaff(provider, userInfo)) {
      let iUserId = await findUserByIdentity(db, provider, userInfo.sub);
      if (!iUserId) {
        // Auto-link by address: the provider has vouched for this one.
        iUserId = await findUserByEmail(db, userInfo.email);
        if (!iUserId) {
          iUserId = await createUser(db, userInfo.email, userInfo.name);
        }
        await ensureIdentity(db, iUserId, provider, userInfo.sub, userInfo.email);
      }
      const sessionId = await createSuperAdminSession(db, iUserId);
      setSessionCookie(res, sessionId);
      return '/internal';
    }

    // ── Link path: attach this identity to the signed-in account ───────────
    if (storedState.context === 'link' && storedState.linkSessionId) {
      const linkSession = await getSession(db, storedState.linkSessionId);
      if (!linkSession?.iUserId) return '/?auth_error=link_expired';

      const back = storedState.returnTo ?? '/';

      // If this account is already an identity, it must be this user's;
      // otherwise two people would share one login.
      const owner = await findUserByIdentity(db, provider, userInfo.sub);
      if (owner && owner !== linkSession.iUserId) {
        return `${back}?link_error=already_linked`;
      }

      await ensureIdentity(db, linkSession.iUserId, provider, userInfo.sub, userInfo.email);

      // Record the address if we didn't have one.
      await db.query(
        `UPDATE auth_tbl_User SET email = COALESCE(email, ?) WHERE iUserId = ?`,
        [userInfo.email, linkSession.iUserId]
      );

      return `${back}?linked=${provider}`;
    }

    // ── Regular login path ─────────────────────────────────────────────────
    const iUserId = await findUserByIdentity(db, provider, userInfo.sub);

    if (!iUserId) {
      // Unknown to Echo. Before turning them away, ask the CRM whether this
      // address belongs to a subscriber — a match on a CRM contact is the
      // basis for binding the account.
      let crmClient: Awaited<ReturnType<typeof findUispClientByEmail>>;
      try {
        crmClient = await findUispClientByEmail(config, userInfo.email);
      } catch (lookupErr) {
        // Couldn't ask — don't guess. Sending them to sign-up here would
        // invite a duplicate org for an existing subscriber.
        logger.error({ err: lookupErr }, '[auth] CRM email lookup failed');
        return '/?auth_error=no_account';
      }

      // Not a subscriber at all → they need to sign up.
      if (!crmClient) return '/sign-up';

      const number = crmClient.hostedPulseNumber
        ? parseInt(crmClient.hostedPulseNumber, 10)
        : null;

      const { iOrgId, iUserId: provisionedUserId } = await provisionFromCrmClient(db, {
        clientId: crmClient.clientId,
        iBusinessNumber: number,
        displayName: crmClient.displayName,
        contactEmail: crmClient.email,
        identity: { provider, subject: userInfo.sub, email: userInfo.email },
      });

      const newSession = await createFullSession(db, {
        iUserId: provisionedUserId,
        iOrgId,
        iBusinessNumber: number,
        role: 'owner',
      });
      setSessionCookie(res, newSession);

      // A subscriber with no hostedPulseNumber is a real org that simply has
      // no number yet — keep the account and send them to buy one.
      logger.info(
        `[auth] matched ${provider} ${userInfo.email} to CRM client ${crmClient.clientId}` +
        (number ? ` (number ${number})` : ' (no number yet)')
      );
      return number ? '/' : '/order-echo';
    }

    // Find membership (user should belong to at least one org)
    const [memberRows] = await db.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT m.iUserId, m.iOrgId, m.role, o.iBusinessNumber
       FROM auth_tbl_Membership m
       INNER JOIN auth_tbl_Org o ON o.iOrgId = m.iOrgId
       WHERE m.iUserId = ? AND m.status = 'active'
       ORDER BY FIELD(m.role,'owner','admin','member'), m.dtCreated ASC
       LIMIT 1`,
      [iUserId]
    );

    if (!memberRows.length) return '/?auth_error=no_membership';

    const member = memberRows[0];
    const sessionId = await createFullSession(db, {
      iUserId,
      iOrgId: member.iOrgId as number,
      iBusinessNumber: member.iBusinessNumber as number,
      role: member.role as 'owner' | 'admin' | 'member',
    });
    setSessionCookie(res, sessionId);
    return '/';
  }

  // ── Google OAuth ─────────────────────────────────────────────────────────────

  // Plain sign-in only. Account linking goes through /auth/google/link, which
  // derives the target user from the server-side session — the context is never
  // taken from the request.
  app.get('/auth/google', async (_req, res) => {
    const state: OAuthState = { csrf: generateId(16), context: 'login', provider: 'google' };
    setOAuthStateCookie(res, state);
    return res.redirect(buildGoogleAuthUrl(config, state));
  });

  app.get('/auth/google/callback', async (req, res, next) => {
    try {
      clearOAuthStateCookie(res);

      if (req.query.error) return res.redirect('/?auth_error=google_denied');
      const code = req.query.code as string;
      if (!code) return res.redirect('/?auth_error=missing_code');

      const checked = checkOAuthState(req, 'google');
      if ('error' in checked) return res.redirect(checked.error);

      const tokens = await exchangeGoogleCode(config, code);
      if (!tokens?.access_token) return res.redirect('/?auth_error=token_exchange_failed');

      const userInfo = await getGoogleUserInfo(tokens.access_token);
      if (!userInfo?.sub) return res.redirect('/?auth_error=userinfo_failed');

      return res.redirect(await completeOAuthLogin(res, 'google', userInfo, checked.state));
    } catch (err) {
      next(err);
    }
  });

  // ── Microsoft (Entra ID) OAuth ───────────────────────────────────────────────

  app.get('/auth/microsoft', async (_req, res) => {
    if (!config.MICROSOFT_CLIENT_ID) return res.redirect('/?auth_error=microsoft_not_configured');
    const state: OAuthState = { csrf: generateId(16), context: 'login', provider: 'microsoft' };
    setOAuthStateCookie(res, state);
    return res.redirect(buildMicrosoftAuthUrl(config, state));
  });

  app.get('/auth/microsoft/callback', async (req, res, next) => {
    try {
      clearOAuthStateCookie(res);

      if (req.query.error) return res.redirect('/?auth_error=microsoft_denied');
      const code = req.query.code as string;
      if (!code) return res.redirect('/?auth_error=missing_code');

      const checked = checkOAuthState(req, 'microsoft');
      if ('error' in checked) return res.redirect(checked.error);

      const tokens = await exchangeMicrosoftCode(config, code);
      if (!tokens?.id_token) return res.redirect('/?auth_error=token_exchange_failed');

      // Microsoft returns the profile in the id_token itself, so there is no
      // second userinfo round-trip as there is for Google.
      const userInfo = parseMicrosoftIdToken(tokens.id_token);
      if (!userInfo?.sub) return res.redirect('/?auth_error=userinfo_failed');

      return res.redirect(await completeOAuthLogin(res, 'microsoft', userInfo, checked.state));
    } catch (err) {
      next(err);
    }
  });

  // ── UISP SSO Callback ────────────────────────────────────────────────────────
  // The UISP bridge plugin redirects here after verifying the client session.
  // ?code=<base64url-payload>&sig=<hmac-hex>

  app.get('/sso/callback', async (req, res, next) => {
    try {
      const code = req.query.code as string;
      const sig = req.query.sig as string;

      if (!code || !sig) return res.redirect('/?auth_error=missing_sso_params');

      if (!config.UISP_SSO_SECRET) {
        logger.error('[sso] UISP_SSO_SECRET not configured');
        return res.redirect('/?auth_error=sso_not_configured');
      }

      const payload = verifySsoCode(config, code, sig);
      if (!payload) return res.redirect('/?auth_error=invalid_sso_code');

      // Single-use nonce guard
      const nonceOk = await consumeNonce(db, payload.nonce, payload.exp);
      if (!nonceOk) return res.redirect('/?auth_error=sso_replay');

      const clientId = payload.clientId;

      // Fetch the CRM client to check hostedPulseNumber
      const uispClient = await fetchUispClient(config, clientId);
      if (!uispClient) {
        logger.warn(`[sso] Could not fetch UISP client ${clientId}`);
        return res.redirect('/?auth_error=uisp_fetch_failed');
      }

      if (!uispClient.hostedPulseNumber) {
        // Client has no Echo number configured
        return res.sendFile(path.join(publicDir, 'no-access.html'));
      }

      const iBusinessNumber = parseInt(uispClient.hostedPulseNumber, 10);

      // The bridge has already proven who this is, so the UISP login is an
      // identity in its own right. No further credential is required.
      const { iOrgId, iUserId, isFirstEntry } = await provisionFromCrmClient(db, {
        clientId,
        iBusinessNumber,
        displayName: uispClient.displayName,
        contactEmail: uispClient.email,
        identity: { provider: 'uisp', subject: clientId, email: uispClient.email },
      });
      if (isFirstEntry) {
        logger.info(`[sso] Provisioned org ${iOrgId} owner ${iUserId} from UISP client ${clientId}`);
      }

      const sessionId = await createFullSession(db, {
        iUserId,
        iOrgId,
        iBusinessNumber,
        role: 'owner',
      });
      setSessionCookie(res, sessionId);

      // Offer Google linking once, as a convenience — never as a gate.
      return res.redirect(isFirstEntry ? '/welcome' : '/');
    } catch (err) {
      next(err);
    }
  });

  // ── Post-provisioning welcome ────────────────────────────────────────────────

  // Shown once after a UISP client's first entry. Linking Google here is purely
  // a convenience so they can sign in without going through the ISP portal;
  // skipping it leaves a fully working account.
  app.get('/welcome', async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.iUserId) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'welcome.html'));
  });

  // Link an additional identity to the already-signed-in user. A user may hold
  // several of either provider; any of them signs them in.
  async function startLink(
    req: express.Request,
    res: express.Response,
    provider: OAuthProvider
  ) {
    const session = await resolveSession(req);
    if (!session?.iUserId) return res.redirect('/');

    // Fixed allowlist — never redirect to a caller-supplied URL.
    const allowed = ['/', '/settings', '/welcome'];
    const requested = String(req.query.return ?? '/');
    const returnTo = allowed.includes(requested) ? requested : '/';

    const state: OAuthState = {
      csrf: generateId(16),
      context: 'link',
      provider,
      linkSessionId: session.sSessionId,
      returnTo,
    };
    setOAuthStateCookie(res, state);
    return res.redirect(
      provider === 'google'
        ? buildGoogleAuthUrl(config, state)
        : buildMicrosoftAuthUrl(config, state)
    );
  }

  app.get('/auth/google/link', (req, res) => startLink(req, res, 'google'));

  app.get('/auth/microsoft/link', (req, res) => {
    if (!config.MICROSOFT_CLIENT_ID) return res.redirect('/?auth_error=microsoft_not_configured');
    return startLink(req, res, 'microsoft');
  });

  // ── Sign-in methods (own account) ────────────────────────────────────────────

  app.get('/api/identities', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      if (!session?.iUserId) return res.status(401).json({ error: 'Not logged in' });

      const rows = await listIdentities(db, session.iUserId);
      return res.json({
        items: rows.map((r) => ({
          iIdentityId: r.iIdentityId,
          provider: r.provider,
          // The Google `sub` is opaque and meaningless to a user, so label by
          // address; fall back to the CRM client id for the ISP binding.
          label: r.email ?? (r.provider === 'uisp' ? `CRM client ${r.subject}` : null),
          dtCreated: r.dtCreated,
          removable: r.provider !== 'uisp',
        })),
      });
    } catch (error) { next(error); }
  });

  app.delete('/api/identities/:id', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      if (!session?.iUserId) return res.status(401).json({ error: 'Not logged in' });

      const id = Number(req.params.id);
      const identity = await getIdentity(db, id);
      if (!identity || identity.iUserId !== session.iUserId) {
        // Don't disclose whether the id exists on someone else's account.
        return res.status(404).json({ error: 'Not found' });
      }
      if (identity.provider === 'uisp') {
        return res.status(400).json({
          error: 'Your ISP sign-in is managed by your provider and cannot be removed here.',
        });
      }
      if ((await countIdentities(db, session.iUserId)) <= 1) {
        return res.status(400).json({
          error: 'This is your only sign-in method — link another before removing it.',
        });
      }

      await deleteIdentity(db, id);
      return res.json({ ok: true });
    } catch (error) { next(error); }
  });

  // ── Super-admin (internal) ───────────────────────────────────────────────────

  app.get('/api/admin/accounts', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      if (!session?.bIsSuperAdmin) return res.status(403).json({ error: 'Forbidden' });
      return res.json({ items: await adminListAccounts(db) });
    } catch (error) { next(error); }
  });

  app.delete('/api/admin/identities/:id', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      if (!session?.bIsSuperAdmin) return res.status(403).json({ error: 'Forbidden' });

      const id = Number(req.params.id);
      const identity = await getIdentity(db, id);
      if (!identity) return res.status(404).json({ error: 'Not found' });

      // Same floor as the self-service path: never strip a user's last way in.
      // A uisp identity removed here is re-attached on the next bridge entry.
      if ((await countIdentities(db, identity.iUserId)) <= 1) {
        return res.status(400).json({
          error: 'That is the user\'s only sign-in method — removing it would lock them out.',
        });
      }

      await deleteIdentity(db, id);
      logger.warn(`[admin] user ${session.iUserId} unlinked identity ${id} (${identity.provider}) from user ${identity.iUserId}`);
      return res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/internal/accounts', async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.bIsSuperAdmin) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'accounts.html'));
  });

  app.get('/internal', async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.bIsSuperAdmin) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'internal.html'));
  });

  app.post('/internal/select-org', async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.bIsSuperAdmin) return res.status(403).json({ error: 'Forbidden' });

    const raw = String(req.body?.businessNumber ?? '').replace(/\D/g, '').slice(0, 10);
    if (!/^\d{10}$/.test(raw)) {
      return res.status(400).send('Business number must be 10 digits');
    }
    const iBusinessNumber = parseInt(raw, 10);

    await updateSessionBusinessNumber(db, session.sSessionId, iBusinessNumber);
    return res.redirect('/');
  });

  // ── Logout ───────────────────────────────────────────────────────────────────

  app.post('/logout', async (req, res) => {
    const session = await resolveSession(req);
    if (session) await deleteSession(db, session.sSessionId);
    clearSessionCookie(res);
    return res.redirect('/');
  });

  // ── Settings page ────────────────────────────────────────────────────────────

  app.get('/settings', async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.iBusinessNumber) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'settings.html'));
  });

  // ── /api/me ──────────────────────────────────────────────────────────────────

  app.get('/api/me', async (req, res) => {
    const session = await resolveSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    const [rows] = await db.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT u.email, o.displayName AS orgName
         FROM auth_tbl_User u
         LEFT JOIN auth_tbl_Org o ON o.iOrgId = ?
        WHERE u.iUserId = ?`,
      [session.iOrgId, session.iUserId]
    );

    return res.json({
      iBusinessNumber: session.iBusinessNumber,
      iOrgId: session.iOrgId,
      iUserId: session.iUserId,
      role: session.role,
      isSuperAdmin: session.bIsSuperAdmin,
      email: rows[0]?.email ?? null,
      orgName: rows[0]?.orgName ?? null,
    });
  });

  // ── Messaging API (all proxy through EchoService) ────────────────────────────

  app.get('/api/conversations', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(config, session, '/api/conversations', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/conversations/:customer/messages', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        config,
        session,
        `/api/conversations/${encodeURIComponent(req.params.customer)}/messages`,
        'GET'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/read', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        config,
        session,
        `/api/conversations/${encodeURIComponent(req.params.customer)}/read`,
        'POST'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/mark-unread', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        config,
        session,
        `/api/conversations/${encodeURIComponent(req.params.customer)}/mark-unread`,
        'POST'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/messages/:messageId', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        config,
        session,
        `/api/messages/${encodeURIComponent(req.params.messageId)}`,
        'DELETE'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/conversations/:customer', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        config,
        session,
        `/api/conversations/${encodeURIComponent(req.params.customer)}`,
        'DELETE'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/send', (req, res, next) => {
    resolveSession(req)
      .then((session) => {
        const body = {
          text: req.body?.text ?? '',
          draftMediaIds: Array.isArray(req.body?.draftMediaIds)
            ? req.body.draftMediaIds
            : [],
        };
        return proxyEchoService(
          config,
          session,
          `/api/conversations/${encodeURIComponent(req.params.customer)}/send`,
          'POST',
          body
        );
      })
      .then((result) => res.status(result.status).json(result.data))
      .catch(next);
  });

  // ── Draft media ──────────────────────────────────────────────────────────────

  app.post('/api/drafts/:customer/media', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const business = session?.iBusinessNumber;
      if (!business) return res.status(401).json({ error: 'Not logged in' });

      const targetUrl = new URL(
        `/api/drafts/${encodeURIComponent(req.params.customer)}/media`,
        config.ECHO_SERVICE_BASE_URL
      );
      targetUrl.searchParams.set('businessNumber', String(business));

      const {
        origin: _o,
        referer: _r,
        cookie: _c,
        host: _h,
        ...forwardHeaders
      } = req.headers;
      forwardHeaders.host = targetUrl.host;

      const transport = targetUrl.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(
        targetUrl,
        { method: 'POST', headers: forwardHeaders },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on('error', next);
      req.pipe(proxyReq);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/drafts/:customer/media', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        config,
        session,
        `/api/drafts/${encodeURIComponent(req.params.customer)}/media`,
        'GET'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/drafts/:customer/media/:draftMediaId', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        config,
        session,
        `/api/drafts/${encodeURIComponent(req.params.customer)}/media/${encodeURIComponent(req.params.draftMediaId)}`,
        'DELETE'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  // ── Settings API proxies ─────────────────────────────────────────────────────

  app.get('/api/carriers', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(config, session, '/api/carriers', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/carrier-applications', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(config, session, '/api/carrier-applications', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/carrier-applications/:id', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(
        config,
        session,
        `/api/carrier-applications/${encodeURIComponent(req.params.id)}`,
        'GET'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/carrier-applications', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(
        config,
        session,
        '/api/carrier-applications',
        'POST',
        req.body
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/carrier-applications/:id', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(
        config,
        session,
        `/api/carrier-applications/${encodeURIComponent(req.params.id)}`,
        'PUT',
        req.body
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/business-phones', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const business = session?.iBusinessNumber;
      if (!business) return res.status(401).json({ error: 'Not logged in' });
      const result = await proxyDirect(
        config,
        session,
        `/api/business-phones/${business}`,
        'GET'
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/business-phones', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const business = session?.iBusinessNumber;
      if (!business) return res.status(401).json({ error: 'Not logged in' });
      const result = await proxyDirect(config, session, '/api/business-phones', 'POST', {
        ...req.body,
        iBusinessNumber: business,
      });
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  // ── Error handler ────────────────────────────────────────────────────────────

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      logger.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  );

  return app;
}
