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
  setLoginStateCookie,
  clearLoginStateCookie,
  checkLoginState,
  fetchUispClient,
  findUispClientByEmail,
  upsertOrg,
  findUserByIdUserId,
  ensureUser,
  createMembership,
  getOwnerMembership,
  findActiveMembership,
  adminListAccounts,
  createSuperAdminSession,
  createFullSession,
  generateId,
  type SessionRow,
  type CrmConfig,
} from './auth';
import { IdClient, buildAuthorizeUrl, exchangeCode, type IdTokenResult } from './idClient';
import {
  verifyIdSignature,
  applyIdEvent,
  getWebhookSecret,
  writeCursor,
  type IdEvent,
} from './idEvents';

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
 * Resolve (or create) the org and owner for a CRM client, then bind the id
 * user that got us here.
 *
 * Whatever provider the person used at id, the rule is the same: one org per
 * CRM client, one owner per org. If the org already has an owner, the
 * incoming id user is that owner (their Echo projection is updated) rather
 * than a rival one being minted.
 */
async function provisionFromCrmClient(
  db: ReturnType<typeof getDb>,
  params: {
    clientId: string;
    iBusinessNumber: number | null;
    displayName: string | null;
    contactEmail: string | null;
    iIdUserId: number;
    email: string | null;
  }
): Promise<{ iOrgId: number; iUserId: number; isFirstEntry: boolean }> {
  const { iOrgId } = await upsertOrg(
    db,
    params.clientId,
    params.iBusinessNumber,
    params.displayName
  );

  let iUserId = await findUserByIdUserId(db, params.iIdUserId);
  let isFirstEntry = false;

  if (!iUserId) {
    const existingOwner = await getOwnerMembership(db, iOrgId);
    if (existingOwner) {
      // The org's owner pre-dates id (or used another login): the id user is
      // that same person, so bind rather than duplicate.
      iUserId = existingOwner.iUserId;
      await db.query(`UPDATE auth_tbl_User SET iIdUserId = ? WHERE iUserId = ?`, [
        params.iIdUserId,
        iUserId,
      ]);
    }
  }

  if (!iUserId) {
    iUserId = await ensureUser(
      db,
      params.iIdUserId,
      params.email ?? params.contactEmail,
      params.displayName
    );
    await createMembership(db, iUserId, iOrgId, 'owner');
    isFirstEntry = true;
  }

  return { iOrgId, iUserId, isFirstEntry };
}

// ─── App builder ──────────────────────────────────────────────────────────────

export function buildApp() {
  const config = loadConfig();
  const db = getDb(config);
  const idClient = new IdClient(config);
  const logger = pino({ level: config.LOG_LEVEL });
  const app = express();

  app.use(
    express.json({
      limit: '1mb',
      // The id signature covers the raw bytes, so a re-serialised object
      // would not verify. Captured only for the receiver route.
      verify: (req, _res, buf) => {
        if (req.url?.startsWith('/id/events')) {
          (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: false }));
  app.use(pinoHttp({ logger }));
  app.use(express.static(publicDir, { index: false }));

  const echoCallbackUrl = `${config.APP_BASE_URL.replace(/\/+$/, '')}/auth/callback`;

  // Browser config. ID_BASE_URL lets pages link to the identity app for
  // sign-in method management; it comes from the shared oAuthConfig table.
  app.get('/config.js', async (_req, res) => {
    let idBase = '';
    try {
      idBase = await idClient.idBaseUrl();
    } catch {
      // Settings store unreachable — pages degrade to not showing id links.
    }
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(
      `window.ECHO_CONFIG=${JSON.stringify({
        MEDIA_BASE_URL: config.MEDIA_BASE_URL,
        ID_BASE_URL: idBase,
      })};`
    );
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'EchoWeb' });
  });

  // ── id event receiver ────────────────────────────────────────────────────────
  // Echo's sessions are its own, so a revocation at id reaches us only here.
  // Answers 2xx only once the event is applied; id retries otherwise, which
  // is why every handler is idempotent.
  app.post('/id/events', async (req, res) => {
    const secret = getWebhookSecret();
    if (!secret) {
      logger.warn('[id-events] delivery arrived before registration completed');
      return res.status(503).json({ error: 'Not registered with id yet' });
    }

    const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? '';
    const ok = verifyIdSignature(
      secret,
      rawBody,
      req.get('X-Id-Timestamp'),
      req.get('X-Id-Signature')
    );
    if (!ok) {
      logger.warn('[id-events] rejected a delivery with a bad or stale signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      const event = req.body as IdEvent;
      await applyIdEvent(db, event, (m) => logger.info(m));
      await writeCursor(db, event.id);
      return res.json({ ok: true });
    } catch (err) {
      // Fail loudly: a non-2xx keeps the event queued at id rather than
      // acknowledging something we did not actually apply.
      logger.error({ err }, '[id-events] handler failed');
      return res.status(500).json({ error: 'Handler failed' });
    }
  });

  // ── Root / login guard ───────────────────────────────────────────────────────

  /**
   * There is no local login page any more. A visitor without a session is
   * sent to the id app; with a live domain-wide SSO session over there the
   * round trip is invisible — they bounce straight back with a code.
   */
  app.get('/', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      if (!session) {
        const idBase = await idClient.idBaseUrl().catch(() => null);
        if (!idBase) {
          return res
            .status(503)
            .send('Sign-in is temporarily unavailable (identity service not configured).');
        }
        const state = generateId(16);
        setLoginStateCookie(res, state);
        return res.redirect(buildAuthorizeUrl(idBase, echoCallbackUrl, state));
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
    } catch (err) {
      next(err);
    }
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

  // ── id callback ──────────────────────────────────────────────────────────────

  /**
   * The id app redirects here with a one-time code after the user has
   * authenticated (by whatever provider id offered). Echo's job is purely
   * membership: map the id user onto an org, provisioning from the UISP CRM
   * when this is their first entry.
   */
  app.get('/auth/callback', async (req, res, next) => {
    try {
      clearLoginStateCookie(res);

      const code = String(req.query.code ?? '');
      const state = String(req.query.state ?? '');
      if (!code) return res.redirect('/?auth_error=missing_code');
      if (!checkLoginState(req, state)) {
        // Neither our own round trip nor an id-initiated SSO entry.
        return res.status(400).send('Login state mismatch — please try signing in again.');
      }

      const settings = await idClient.getSettings();
      const idBase = await idClient.idBaseUrl();
      const clientSecret = settings.ID_CLIENT_SECRET;
      if (!clientSecret) {
        logger.error('[auth] oAuthConfig ID_CLIENT_SECRET is not set');
        return res.status(503).send('Sign-in is temporarily unavailable.');
      }

      const result = await exchangeCode(idBase, {
        code,
        redirectUri: echoCallbackUrl,
        clientSecret,
      });
      if (!result) return res.redirect('/?auth_error=code_rejected');

      return res.redirect(await completeLogin(res, result, settings));
    } catch (err) {
      next(err);
    }
  });

  /**
   * Everything that happens once id has told us who the user is. Sets the
   * session cookie as a side effect; returns where to send the browser.
   */
  async function completeLogin(
    res: express.Response,
    result: IdTokenResult,
    settings: Record<string, string>
  ): Promise<string> {
    const { user, identity, identities } = result;

    // ── Super System Admin (id verified the domain) ─────────────────────────
    if (user.superAdmin) {
      const iUserId = await ensureUser(db, user.iUserId, user.email, user.displayName);
      const sessionId = await createSuperAdminSession(db, iUserId);
      setSessionCookie(res, sessionId);
      return '/internal';
    }

    // ── Known Echo user ─────────────────────────────────────────────────────
    const existing = await findUserByIdUserId(db, user.iUserId);
    if (existing) {
      const membership = await findActiveMembership(db, existing);
      if (!membership) return '/?auth_error=no_membership';
      const sessionId = await createFullSession(db, {
        iUserId: existing,
        iOrgId: membership.iOrgId,
        iBusinessNumber: membership.iBusinessNumber,
        role: membership.role,
      });
      setSessionCookie(res, sessionId);
      return membership.iBusinessNumber ? '/' : '/order-echo';
    }

    // ── First entry: provision from the UISP CRM ────────────────────────────
    const crm: CrmConfig = {
      UISP_BASE_URL: settings.UISP_BASE_URL ?? '',
      UISP_CRM_APP_KEY_READ: settings.UISP_CRM_APP_KEY_READ ?? '',
    };
    if (!crm.UISP_BASE_URL || !crm.UISP_CRM_APP_KEY_READ) {
      logger.error('[auth] UISP CRM settings missing from oAuthConfig');
      return '/?auth_error=no_account';
    }

    // A uisp identity carries the CRM clientId as its subject — the strongest
    // possible binding, used when present. Otherwise fall back to matching a
    // CRM contact by the verified address id gave us.
    const uispIdentity =
      identity.provider === 'uisp'
        ? identity
        : (identities.find((i) => i.provider === 'uisp') ?? null);

    let crmClient: Awaited<ReturnType<typeof findUispClientByEmail>> = null;
    if (uispIdentity?.subject) {
      crmClient = await fetchUispClient(crm, uispIdentity.subject);
      if (!crmClient) {
        logger.warn(`[auth] Could not fetch UISP client ${uispIdentity.subject}`);
        return '/?auth_error=uisp_fetch_failed';
      }
    } else if (user.email) {
      try {
        crmClient = await findUispClientByEmail(crm, user.email);
      } catch (lookupErr) {
        // Couldn't ask — don't guess. Sending them to sign-up here would
        // invite a duplicate org for an existing subscriber.
        logger.error({ err: lookupErr }, '[auth] CRM email lookup failed');
        return '/?auth_error=no_account';
      }
    }

    // Not a subscriber at all → they need to sign up.
    if (!crmClient) return '/sign-up';

    const number = crmClient.hostedPulseNumber
      ? parseInt(crmClient.hostedPulseNumber, 10)
      : null;

    const { iOrgId, iUserId } = await provisionFromCrmClient(db, {
      clientId: crmClient.clientId,
      iBusinessNumber: number,
      displayName: crmClient.displayName,
      contactEmail: crmClient.email,
      iIdUserId: user.iUserId,
      email: user.email,
    });

    const sessionId = await createFullSession(db, {
      iUserId,
      iOrgId,
      iBusinessNumber: number,
      role: 'owner',
    });
    setSessionCookie(res, sessionId);

    // A subscriber with no hostedPulseNumber is a real org that simply has
    // no number yet — keep the account and send them to buy one.
    logger.info(
      `[auth] matched id user ${user.iUserId} to CRM client ${crmClient.clientId}` +
        (number ? ` (number ${number})` : ' (no number yet)')
    );
    return number ? '/' : '/order-echo';
  }

  // ── Super-admin (internal) ───────────────────────────────────────────────────

  app.get('/api/admin/accounts', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      if (!session?.bIsSuperAdmin) return res.status(403).json({ error: 'Forbidden' });
      return res.json({ items: await adminListAccounts(db) });
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

  /**
   * Ends the Echo session AND the domain-wide id session. Clearing only the
   * local cookie would look broken: the next visit to / would silently sign
   * the user straight back in off the id SSO cookie.
   */
  app.post('/logout', async (req, res) => {
    const session = await resolveSession(req);
    if (session) await deleteSession(db, session.sSessionId);
    clearSessionCookie(res);
    const idBase = await idClient.idBaseUrl().catch(() => null);
    return res.redirect(idBase ? `${idBase}/logout` : '/');
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
