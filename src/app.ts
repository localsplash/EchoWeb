import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { loadConfig, loadEnv, ensureFreshConfig } from './config';
import { SettingsUnavailableError } from './settings';
import { getDb } from './db';
import { registerMediaRoute } from './media';
import {
  getSessionIdFromRequest,
  setSessionCookie,
  clearSessionCookie,
  setOAuthStateCookie,
  clearOAuthStateCookie,
  getOAuthStateFromRequest,
  redeemIdentityCode,
  generateId,
  type OAuthState,
} from './auth';
import {
  resolvePlatformSession,
  identityRequest,
  selectBusiness,
  IdentityUnavailableError,
  TenantBoundaryError,
  type PlatformSession as SessionRow,
} from './platformSession';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const publicDir = path.join(__dirname, '..', 'public');

// ─── Session resolution ───────────────────────────────────────────────────────

async function resolveSession(
  req: express.Request,
): Promise<SessionRow | null> {
  const token = getSessionIdFromRequest(req);
  if (!token) return null;
  return resolvePlatformSession(
    getDb(loadEnv()),
    loadConfig(),
    token,
    readBusinessCookie(req),
  );
}

// ─── Proxy helpers ────────────────────────────────────────────────────────────

// Proxy that does NOT inject businessNumber — used for settings endpoints.
async function proxyDirect(
  config: ReturnType<typeof loadConfig>,
  session: SessionRow | null,
  targetPath: string,
  method: ApiMethod,
  body?: unknown,
) {
  if (!session) return { status: 401, data: { error: 'Not logged in' } };
  if (!session.iBusinessNumber && !session.bIsSuperAdmin)
    return { status: 403, data: { error: 'Choose an authorized business' } };

  if (
    (targetPath.startsWith('/api/carrier') || method !== 'GET') &&
    !session?.bIsSuperAdmin
  ) {
    return {
      status: 403,
      data: {
        error: 'Platform administrator required for carrier configuration',
      },
    };
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
  body?: unknown,
) {
  const business = session?.iBusinessNumber;
  if (!session) return { status: 401, data: { error: 'Not logged in' } };
  if (!business)
    return { status: 403, data: { error: 'Choose an authorized business' } };

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
            ...(body && typeof body === 'object' ? body : {}),
            businessNumber: business,
          }),
  });

  const data = await response
    .json()
    .catch(() => ({ error: 'Invalid response from EchoService' }));
  return { status: response.status, data };
}

function readBusinessCookie(req: express.Request): string | null {
  const value = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('echo_business='))
    ?.slice('echo_business='.length);
  return value && /^\d{10}$/.test(value) ? value : null;
}
function setBusinessCookie(res: express.Response, number: number | null): void {
  res.append(
    'Set-Cookie',
    `echo_business=${number ?? ''}; Path=/; Max-Age=${number ? 2592000 : 0}; HttpOnly; SameSite=Lax; Secure`,
  );
}

// ─── App builder ──────────────────────────────────────────────────────────────

export function buildApp() {
  const env = loadEnv();
  const db = getDb(env);
  const logger = pino({
    level: env.LOG_LEVEL,
    redact: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers[\"set-cookie\"]',
      'res.headers.location',
      'req.query.code',
      'req.query.sig',
      'req.query.state',
    ],
  });
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return { ...req, url: String(req.url ?? '').split('?')[0] };
        },
      },
    }),
  );

  // Settings-free, so it answers while the store is down: "the process is
  // up" stays distinguishable from "the process cannot read its settings".
  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, service: 'EchoWeb' }),
  );

  /**
   * Keep the settings snapshot fresh before anything reads it.
   *
   * The store caches for 30 seconds, so this is a comparison on the hot path
   * and a settings read at most twice a minute — and a changed row reaches
   * this app within that window, with no restart. A failure is not swallowed:
   * it travels to the handler below, which answers 503 saying which of
   * unreachable / missing / ambiguous it was.
   */
  app.use((_req, _res, next) => {
    ensureFreshConfig(db).then(() => next(), next);
  });

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('Origin');
    if (!origin || origin !== new URL(loadConfig().APP_BASE_URL).origin)
      return res.status(403).json({ error: 'Same-origin request required' });
    next();
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await db.query(
        'SELECT iOrgId,iTenantId,iBusinessNumber FROM echo_tbl_PlatformOrgMap LIMIT 0',
      );
      res.json({ ok: true });
    } catch {
      res
        .status(503)
        .json({ error: 'Echo platform mapping schema is unavailable' });
    }
  });
  registerMediaRoute(app, db, loadConfig, resolveSession);
  app.use(express.static(publicDir, { index: false }));

  // Browser config (media URL, UISP plugin URL, which logins are available).
  // Rebuilt per request from the current settings rather than frozen at
  // boot, so a changed settings row reaches the browser too.
  app.get('/config.js', (_req, res) => {
    const current = loadConfig();
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(
      `window.ECHO_CONFIG=${JSON.stringify({
        MEDIA_BASE_URL: current.MEDIA_INTERNAL_BASE_URL
          ? '/api/media'
          : current.MEDIA_BASE_URL,
        UISP_PLUGIN_URL: current.UISP_PLUGIN_URL,
        // The Pusher key and cluster are public by design — the client has to
        // present the key to connect. The app id and secret stay in
        // EchoService. Blank here means the browser polls instead (#15/#16).
        PUSHER_KEY: current.PUSHER_KEY,
        PUSHER_CLUSTER: current.PUSHER_CLUSTER,
      })};`,
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
      return res.redirect('/choose-business');
    }
    if (!session.iBusinessNumber) {
      // A real account whose org has no number yet — the messaging UI would be
      // an empty shell and every API call would 401, so route them to ordering.
      return res.redirect('/choose-business');
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

  // ── Sign-in, brokered by the identity service ────────────────────────────────

  /**
   * Every way into Echo now starts here.
   *
   * identity is the platform's single sign-in surface: it holds the Google and
   * Microsoft client registrations and the UISP bridge, so one OAuth redirect
   * URI is registered once for the whole platform instead of one per app. This
   * app no longer talks to a provider at all — it asks identity who arrived.
   *
   * Identity returns an opaque central application session. Echo resolves current
   * membership and verified historical number mappings without local provisioning.
   */
  function identityAuthorizeUrl(
    config: ReturnType<typeof loadConfig>,
    state: string,
  ): string {
    const url = new URL('/authorize', config.IDENTITY_PUBLIC_BASE_URL || config.IDENTITY_BASE_URL);
    url.searchParams.set('redirect_uri', identityRedirectUri(config));
    url.searchParams.set('state', state);
    return url.toString();
  }

  function identityRedirectUri(config: ReturnType<typeof loadConfig>): string {
    return `${config.APP_BASE_URL}/auth/identity/callback`;
  }

  app.get('/auth/identity', (req, res) => {
    const config = loadConfig();
    if (!config.IDENTITY_BASE_URL)
      return res.redirect('/?auth_error=identity_not_configured');
    // Carried through identity and handed back verbatim, so the reply can be
    // tied to the request that started it.
    const state: OAuthState = {
      csrf: generateId(16),
      context: 'login',
      provider: 'google',
      returnTo:
        typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined,
    };
    setOAuthStateCookie(res, state);
    return res.redirect(identityAuthorizeUrl(config, state.csrf));
  });

  app.get('/auth/identity/callback', async (req, res, next) => {
    try {
      const config = loadConfig();
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const returned =
        typeof req.query.state === 'string' ? req.query.state : '';
      if (!code) return res.redirect('/?auth_error=missing_code');

      const stored = getOAuthStateFromRequest(req);
      clearOAuthStateCookie(res);

      // Unsolicited Identity/UISP entries restart the browser-bound handshake;
      // only a callback matching our generated state is redeemed.
      if (returned === 'sso') return res.redirect('/auth/identity');
      {
        if (!stored || !returned || stored.csrf !== returned) {
          return res.redirect('/?auth_error=state');
        }
      }

      const claim = await redeemIdentityCode(
        config,
        code,
        identityRedirectUri(config),
      );
      if (!claim) return res.redirect('/?auth_error=token_exchange_failed');

      if (!claim.appSession?.token)
        return res.redirect('/?auth_error=identity_upgrade_required');
      const central = await resolvePlatformSession(
        db,
        config,
        claim.appSession.token,
        null,
      );
      if (!central) return res.redirect('/?auth_error=invalid_session');
      setSessionCookie(res, claim.appSession.token);
      setBusinessCookie(res, null);
      // Single-business users go straight to their existing messages. A multi-
      // business user chooses an explicit central tenant and mapped number.
      if (central.businesses.length === 1) {
        const business = await selectBusiness(
          config,
          central,
          central.businesses[0].iBusinessNumber,
        );
        setBusinessCookie(res, business.iBusinessNumber);
        return res.redirect('/');
      }
      return res.redirect('/choose-business');
    } catch (err) {
      next(err);
    }
  });

  // Old entry points, kept so bookmarks and the UISP plugin keep working.
  // They no longer start an OAuth flow of their own; they hand over.
  app.get('/auth/google', (_req, res) => res.redirect('/auth/identity'));
  app.get('/auth/microsoft', (_req, res) => res.redirect('/auth/identity'));

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
    if (!config.IDENTITY_BASE_URL)
      return res.redirect('/?auth_error=identity_not_configured');
    const onward = new URL('/sso/callback', config.IDENTITY_PUBLIC_BASE_URL || config.IDENTITY_BASE_URL);
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
  app.get(
    ['/auth/google/link', '/auth/microsoft/link', '/auth/link'],
    (_req, res) => {
      const config = loadConfig();
      if (!config.IDENTITY_BASE_URL)
        return res.redirect('/?auth_error=identity_not_configured');
      return res.redirect(
        new URL('/account', config.IDENTITY_PUBLIC_BASE_URL || config.IDENTITY_BASE_URL).toString(),
      );
    },
  );

  // Identity owns account/login management. Legacy Echo auth rows are preserved
  // for migration evidence and are never read or written as current authority.
  app.get('/api/identities', (_req, res) =>
    res
      .status(410)
      .json({
        error: 'Manage sign-in methods in Identity',
        manageUrl: new URL(
          '/account',
          loadConfig().IDENTITY_PUBLIC_BASE_URL || loadConfig().IDENTITY_BASE_URL,
        ).toString(),
      }),
  );
  app.delete(
    ['/api/identities/:id', '/api/admin/identities/:id'],
    (_req, res) =>
      res.status(410).json({ error: 'Identity owns sign-in methods' }),
  );
  app.get('/api/admin/accounts', (_req, res) =>
    res.status(410).json({ error: 'Identity owns the account directory' }),
  );
  app.get('/internal/accounts', (_req, res) =>
    res.redirect(new URL('/admin', loadConfig().IDENTITY_PUBLIC_BASE_URL || loadConfig().IDENTITY_BASE_URL).toString()),
  );
  app.get(['/choose-business', '/internal'], async (req, res) => {
    if (!(await resolveSession(req))) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'businesses.html'));
  });
  app.get('/api/businesses', async (req, res) => {
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: 'Not logged in' });
    res.json({ items: session.businesses });
  });
  app.post(['/internal/select-org', '/select-business'], async (req, res) => {
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: 'Not logged in' });
    const raw = String(req.body?.businessNumber ?? '');
    if (!/^\d{10}$/.test(raw))
      return res
        .status(400)
        .json({ error: 'Business number must be 10 digits' });
    const binding = await selectBusiness(loadConfig(), session, Number(raw));
    setBusinessCookie(res, binding.iBusinessNumber);
    res.redirect('/');
  });
  app.post('/logout', async (req, res) => {
    const token = getSessionIdFromRequest(req);
    if (token && /^[0-9a-f]{64}$/.test(token))
      await identityRequest(loadConfig(), '/api/sessions/revoke', { token });
    clearSessionCookie(res);
    setBusinessCookie(res, null);
    res.redirect('/');
  });

  // ── Settings page ────────────────────────────────────────────────────────────

  app.get('/settings', async (req, res) => {
    const session = await resolveSession(req);
    if (session && !session.bIsSuperAdmin)
      return res.redirect(
        new URL('/account', loadConfig().IDENTITY_PUBLIC_BASE_URL || loadConfig().IDENTITY_BASE_URL).toString(),
      );
    if (!session?.iBusinessNumber) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'settings.html'));
  });

  // ── /api/me ──────────────────────────────────────────────────────────────────

  app.get('/api/me', async (req, res) => {
    const session = await resolveSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    return res.json({
      iBusinessNumber: session.iBusinessNumber,
      iOrgId: session.iOrgId,
      iUserId: session.iUserId,
      role: session.role,
      isSuperAdmin: session.bIsSuperAdmin,
      email: session.email,
      orgName: session.orgName,
      iTenantId: session.iTenantId,
    });
  });

  // ── Messaging API (all proxy through EchoService) ────────────────────────────

  app.get('/api/conversations', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        loadConfig(),
        session,
        '/api/conversations',
        'GET',
      );
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
        'GET',
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
        'POST',
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/api/conversations/:customer/mark-unread',
    async (req, res, next) => {
      try {
        const session = await resolveSession(req);
        const result = await proxyEchoService(
          loadConfig(),
          session,
          `/api/conversations/${encodeURIComponent(req.params.customer)}/mark-unread`,
          'POST',
        );
        return res.status(result.status).json(result.data);
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete('/api/messages/:messageId', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyEchoService(
        loadConfig(),
        session,
        `/api/messages/${encodeURIComponent(req.params.messageId)}`,
        'DELETE',
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
        'DELETE',
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
          body,
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
        },
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
        loadConfig().ECHO_SERVICE_BASE_URL,
      );
      targetUrl.searchParams.set('businessNumber', String(business));

      const {
        origin: _o,
        referer: _r,
        cookie: _c,
        authorization: _a,
        'x-id-client-secret': _s,
        'x-forwarded-for': _xff,
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
        },
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
        'GET',
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete(
    '/api/drafts/:customer/media/:draftMediaId',
    async (req, res, next) => {
      try {
        const session = await resolveSession(req);
        const result = await proxyEchoService(
          loadConfig(),
          session,
          `/api/drafts/${encodeURIComponent(req.params.customer)}/media/${encodeURIComponent(req.params.draftMediaId)}`,
          'DELETE',
        );
        return res.status(result.status).json(result.data);
      } catch (error) {
        next(error);
      }
    },
  );

  // ── Settings API proxies ─────────────────────────────────────────────────────

  app.get('/api/carriers', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(
        loadConfig(),
        session,
        '/api/carriers',
        'GET',
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/carrier-applications', async (req, res, next) => {
    try {
      const session = await resolveSession(req);
      const result = await proxyDirect(
        loadConfig(),
        session,
        '/api/carrier-applications',
        'GET',
      );
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
        'GET',
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
        req.body,
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
        req.body,
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
        'GET',
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
      const result = await proxyDirect(
        loadConfig(),
        session,
        '/api/business-phones',
        'POST',
        {
          ...req.body,
          iBusinessNumber: business,
        },
      );
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
      _next: express.NextFunction,
    ) => {
      logger.error(err);
      // A settings store that cannot answer is a configuration fault, and
      // saying so beats a 500 that reads as an application fault.
      if (err instanceof IdentityUnavailableError)
        return res.status(503).json({ error: err.message });
      if (err instanceof TenantBoundaryError)
        return res.status(403).json({ error: err.message });
      if (err instanceof SettingsUnavailableError) {
        return res.status(503).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
