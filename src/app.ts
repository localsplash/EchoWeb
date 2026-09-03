import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { loadConfig, loadEnv, ensureFreshConfig } from './config';
import { SettingsUnavailableError } from './settings';
import { getDb } from './db';
import {
  getSessionIdFromRequest,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  deleteSession,
  updateSessionBusinessNumber,
  setOAuthStateCookie,
  clearOAuthStateCookie,
  getOAuthStateFromRequest,
  redeemIdentityCode,
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
  // The pool is memoised; its coordinates come from the environment, not the
  // settings, so this needs no snapshot.
  const db = getDb(loadEnv());
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
  const env = loadEnv();
  const db = getDb(env);
  const logger = pino({ level: env.LOG_LEVEL });
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(pinoHttp({ logger }));

  // Settings-free, so it answers while the store is down: "the process is
  // up" stays distinguishable from "the process cannot read its settings".
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'EchoWeb' }));

  /**
   * Keep the settings snapshot fresh before anything reads it.
   *
   * The store caches for 30 seconds, so this is a comparison on the hot path
   * and a NocoDB read at most twice a minute — and a change made in NocoDB
   * reaches this app within that window, with no restart. A failure is not
   * swallowed: it travels to the handler below, which answers 503 saying
   * which of unreachable / missing / ambiguous it was.
   */
  app.use((_req, _res, next) => {
    ensureFreshConfig(db).then(() => next(), next);
  });

  app.use(express.static(publicDir, { index: false }));

  // Browser config (media URL, UISP plugin URL, which logins are available).
  // Rebuilt per request from the current settings rather than frozen at
  // boot, so flipping a value in NocoDB reaches the browser too.
  app.get('/config.js', (_req, res) => {
    const current = loadConfig();
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(
      `window.ECHO_CONFIG=${JSON.stringify({
        MEDIA_BASE_URL: current.MEDIA_BASE_URL,
        UISP_PLUGIN_URL: current.UISP_PLUGIN_URL,
        // Only the flag — never the client id, which the browser has no use for.
        MICROSOFT_ENABLED: Boolean(current.MICROSOFT_CLIENT_ID),
        // The Pusher key and cluster are public by design — the client has to
        // present the key to connect. The app id and secret stay in
        // EchoService. Blank here means the browser polls instead (#15/#16).
        PUSHER_KEY: current.PUSHER_KEY,
        PUSHER_CLUSTER: current.PUSHER_CLUSTER,
      })};`
    );
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
    storedState: OAuthState,
    superAdmin: boolean
  ): Promise<string> {
    // ── Super-admin path ───────────────────────────────────────────────────
    //
    // `superAdmin` is identity's claim, not a rule of ours. It computes it at
    // login from SUPERADMIN_DOMAIN (falling back to PARENT_DOMAIN) and only
    // for a provider that actually vouches for the domain — the same care this
    // app used to take by hand for @wisp.net on Google alone, but decided once
    // for the whole platform instead of once per app. It rides on the one-time
    // code and is never recomputed from the address at redemption, so a
    // forwarded address cannot become a privilege here.
    if (superAdmin) {
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
        crmClient = await findUispClientByEmail(loadConfig(), userInfo.email);
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

  // ── Sign-in, brokered by the identity service ────────────────────────────────

  /**
   * Every way into Echo now starts here.
   *
   * identity is the platform's single sign-in surface: it holds the Google and
   * Microsoft client registrations and the UISP bridge, so one OAuth redirect
   * URI is registered once for the whole platform instead of one per app. This
   * app no longer talks to a provider at all — it asks identity who arrived.
   *
   * What comes back is the same shape the provider used to give us — a
   * provider, a subject and an address — so everything downstream
   * (completeOAuthLogin: the super-admin rule, the CRM match, org
   * provisioning, membership) is untouched. Only the way we learn it changed.
   */
  function identityAuthorizeUrl(config: ReturnType<typeof loadConfig>, state: string): string {
    const url = new URL('/authorize', config.IDENTITY_BASE_URL);
    url.searchParams.set('redirect_uri', identityRedirectUri(config));
    url.searchParams.set('state', state);
    return url.toString();
  }

  function identityRedirectUri(config: ReturnType<typeof loadConfig>): string {
    return `${config.APP_BASE_URL}/auth/identity/callback`;
  }

  app.get('/auth/identity', (req, res) => {
    const config = loadConfig();
    if (!config.IDENTITY_BASE_URL) return res.redirect('/?auth_error=identity_not_configured');
    // Carried through identity and handed back verbatim, so the reply can be
    // tied to the request that started it.
    const state: OAuthState = {
      csrf: generateId(16),
      context: 'login',
      provider: 'google',
      returnTo: typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined,
    };
    setOAuthStateCookie(res, state);
    return res.redirect(identityAuthorizeUrl(config, state.csrf));
  });

  app.get('/auth/identity/callback', async (req, res, next) => {
    try {
      const config = loadConfig();
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const returned = typeof req.query.state === 'string' ? req.query.state : '';
      if (!code) return res.redirect('/?auth_error=missing_code');

      const stored = getOAuthStateFromRequest(req);
      clearOAuthStateCookie(res);

      // Two ways to arrive, and they are told apart by the state.
      //
      // `sso` is identity's marker for an unsolicited entry — someone came
      // straight from the ISP portal, so there was never a request of ours for
      // this to match. There is nothing to compare against, and nothing is
      // weakened by saying so: the code is single-use, minted for this exact
      // redirect_uri, and redeemed server-to-server below. The browser never
      // carries anything that would let a third party mint one.
      //
      // Anything else has to match the cookie we set on the way out.
      if (returned !== 'sso') {
        if (!stored || !returned || stored.csrf !== returned) {
          return res.redirect('/?auth_error=state');
        }
      }

      const claim = await redeemIdentityCode(config, code, identityRedirectUri(config));
      if (!claim) return res.redirect('/?auth_error=token_exchange_failed');

      const provider = claim.identity.provider;
      const subject = claim.identity.subject;
      if (!provider || !subject) return res.redirect('/?auth_error=userinfo_failed');

      const userInfo: OAuthUserInfo = {
        sub: subject,
        email: claim.user.email ?? '',
        name: claim.user.displayName ?? '',
      };

      // The ISP bridge is an identity in its own right and carries the CRM
      // client id as its subject, so it provisions directly instead of going
      // looking for the subscriber by address.
      if (provider === 'uisp') {
        const dest = await completeUispLogin(res, subject, userInfo.email || null);
        return res.redirect(dest);
      }

      const dest = await completeOAuthLogin(
        res,
        provider as OAuthProvider,
        userInfo,
        stored ?? { csrf: '', context: 'login', provider: provider as OAuthProvider },
        claim.user.superAdmin === true
      );
      return res.redirect(dest);
    } catch (err) {
      next(err);
    }
  });

  /**
   * The ISP bridge, once identity has verified it.
   *
   * Lifted out of the old /sso/callback unchanged apart from where the client
   * id comes from: identity checked the HMAC and burned the nonce, so what
   * arrives here is already proven.
   */
  async function completeUispLogin(
    res: express.Response,
    clientId: string,
    email: string | null
  ): Promise<string> {
    const uispClient = await fetchUispClient(loadConfig(), clientId);
    if (!uispClient) {
      logger.warn(`[sso] Could not fetch UISP client ${clientId}`);
      return '/?auth_error=uisp_fetch_failed';
    }
    if (!uispClient.hostedPulseNumber) return '/no-access.html';

    const iBusinessNumber = parseInt(uispClient.hostedPulseNumber, 10);
    const { iOrgId, iUserId, isFirstEntry } = await provisionFromCrmClient(db, {
      clientId,
      iBusinessNumber,
      displayName: uispClient.displayName,
      contactEmail: uispClient.email ?? email,
      identity: { provider: 'uisp', subject: clientId, email: uispClient.email ?? email },
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
    return isFirstEntry ? '/welcome' : '/';
  }

  // Old entry points, kept so bookmarks and the UISP plugin keep working.
  // They no longer start an OAuth flow of their own; they hand over.
  app.get('/auth/google', (_req, res) => res.redirect('/auth/identity'));
  app.get('/auth/microsoft', (_req, res) => res.redirect('/auth/identity'));

  // ── Google OAuth ─────────────────────────────────────────────────────────────

  // Plain sign-in only. Account linking goes through /auth/google/link, which
  // derives the target user from the server-side session — the context is never
  // taken from the request.


  // ── Microsoft (Entra ID) OAuth ───────────────────────────────────────────────



  // ── UISP SSO Callback ────────────────────────────────────────────────────────
  // The UISP bridge plugin redirects here after verifying the client session.
  // ?code=<base64url-payload>&sig=<hmac-hex>


  /**
   * The ISP bridge, forwarded to identity.
   *
   * The UISP plugin posts its signed code at whatever URL it was configured
   * with, and on every install that predates the move that is this one. Rather
   * than make an ISP admin edit the plugin before their customers can sign in,
   * the signature travels on untouched to identity, which now holds the same
   * UISP_SSO_SECRET and does the verifying.
   *
   * identity checks the HMAC, burns the nonce, and — with no /authorize
   * request of ours pending — falls back to DEFAULT_REDIRECT_URI, which points
   * at /auth/identity/callback here. The round trip completes and the user
   * lands signed in, having never seen this hop.
   *
   * Repointing the plugin straight at identity is strictly better and makes
   * this dead code; it stays until every plugin has moved.
   */
  app.get('/sso/callback', (req, res) => {
    const config = loadConfig();
    if (!config.IDENTITY_BASE_URL) return res.redirect('/?auth_error=identity_not_configured');
    const onward = new URL('/sso/callback', config.IDENTITY_BASE_URL);
    for (const key of ['code', 'sig'] as const) {
      const value = req.query[key];
      if (typeof value === 'string') onward.searchParams.set(key, value);
    }
    return res.redirect(onward.toString());
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



  /**
   * Managing which logins reach an account is identity's job, not this app's —
   * the identities live in its database and are shared by every application on
   * the platform. So this hands over to the place that owns them rather than
   * keeping a second, Echo-only version of the same screen.
   */
  app.get(['/auth/google/link', '/auth/microsoft/link', '/auth/link'], (_req, res) => {
    const config = loadConfig();
    if (!config.IDENTITY_BASE_URL) return res.redirect('/?auth_error=identity_not_configured');
    return res.redirect(new URL('/account', config.IDENTITY_BASE_URL).toString());
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
      const result = await proxyEchoService(loadConfig(), session, '/api/conversations', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/conversations/:customer/messages', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        loadConfig(),
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
        loadConfig(),
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
        loadConfig(),
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
        loadConfig(),
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
        loadConfig(),
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
          loadConfig(),
          session,
          `/api/conversations/${encodeURIComponent(req.params.customer)}/send`,
          'POST',
          body
        );
      })
      .then((result) => res.status(result.status).json(result.data))
      .catch(next);
  });

  /**
   * Authorize a Pusher private channel subscription (#16).
   *
   * The browser cannot sign for itself — that needs the Pusher secret, which
   * lives in EchoService and stays there. So the client's socket_id and
   * channel_name come here on its session cookie, and go on to EchoService
   * with the business number resolved from that session. EchoService refuses
   * to sign a channel that does not belong to the business it was told about,
   * which is what stops one business subscribing to another's messages.
   *
   * Pusher's client posts this as a form; express.urlencoded above has already
   * turned it into req.body by the time we get here.
   */
  app.post('/api/pusher/auth', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        loadConfig(),
        session,
        '/api/pusher/auth',
        'POST',
        {
          socket_id: req.body?.socket_id ?? '',
          channel_name: req.body?.channel_name ?? '',
        }
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  // ── Draft media ──────────────────────────────────────────────────────────────

  app.post('/api/drafts/:customer/media', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const business = session?.iBusinessNumber;
      if (!business) return res.status(401).json({ error: 'Not logged in' });

      const targetUrl = new URL(
        `/api/drafts/${encodeURIComponent(req.params.customer)}/media`,
        loadConfig().ECHO_SERVICE_BASE_URL
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
        loadConfig(),
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
        loadConfig(),
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
      const result = await proxyDirect(loadConfig(), session, '/api/carriers', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/carrier-applications', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(loadConfig(), session, '/api/carrier-applications', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/carrier-applications/:id', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(
        loadConfig(),
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
        loadConfig(),
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
        loadConfig(),
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
        loadConfig(),
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
      const result = await proxyDirect(loadConfig(), session, '/api/business-phones', 'POST', {
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
      // A settings store that cannot answer is a configuration fault, and
      // saying so beats a 500 that reads as an application fault.
      if (err instanceof SettingsUnavailableError) {
        return res.status(503).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  );

  return app;
}
