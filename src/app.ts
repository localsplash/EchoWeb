import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { loadConfig } from './config';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

function parseCookie(req: express.Request, key: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === key) return decodeURIComponent(v.join('='));
  }
  return null;
}

function getBusinessNumberFromSession(req: express.Request): number | null {
  const value = parseCookie(req, 'businessNumber');
  if (!value || !/^\d{10}$/.test(value)) return null;
  return Number(value);
}

const publicDir = path.join(__dirname, '..', 'public');

// Proxy that does NOT inject businessNumber — used for settings endpoints.
// Still requires a valid session so unauthenticated requests are rejected.
async function proxyDirect(config: ReturnType<typeof loadConfig>, req: express.Request, targetPath: string, method: ApiMethod, body?: unknown) {
  const business = getBusinessNumberFromSession(req);
  if (!business) return { status: 401, data: { error: 'Not logged in' } };

  const url = new URL(targetPath, config.ECHO_SERVICE_BASE_URL);
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  const data = await response.json().catch(() => ({ error: 'Invalid response from EchoService' }));
  return { status: response.status, data };
}

async function proxyEchoService(config: ReturnType<typeof loadConfig>, req: express.Request, path: string, method: ApiMethod, body?: unknown) {
  const business = getBusinessNumberFromSession(req);
  if (!business) return { status: 401, data: { error: 'Not logged in' } };

  const url = new URL(path, config.ECHO_SERVICE_BASE_URL);
  if (method === 'GET' || method === 'DELETE') url.searchParams.set('businessNumber', String(business));

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify({ businessNumber: business, ...(body && typeof body === 'object' ? body : {}) })
  });

  const data = await response.json().catch(() => ({ error: 'Invalid response from EchoService' }));
  return { status: response.status, data };
}

export function buildApp() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(pinoHttp({ logger }));
  app.use(express.static(publicDir, { index: false }));

  // Serve browser-facing config (MEDIA_BASE_URL, etc.) as a cacheable JS snippet.
  // Loaded by index.html before app.js via <script src="/config.js">.
  const configJs = `window.ECHO_CONFIG=${JSON.stringify({ MEDIA_BASE_URL: config.MEDIA_BASE_URL })};`;
  app.get('/config.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(configJs);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'EchoWeb' });
  });

  app.get('/', (req, res) => {
    const business = getBusinessNumberFromSession(req);
    if (!business) return res.sendFile(path.join(publicDir, 'login.html'));
    return res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.post('/login', (req, res) => {
    const businessNumber = String(req.body?.businessNumber ?? '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(businessNumber)) {
      return res.status(400).send('Business number must be 10 digits');
    }
    res.setHeader('Set-Cookie', `businessNumber=${businessNumber}; Path=/; HttpOnly; SameSite=Lax`);
    return res.redirect('/');
  });

  app.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'businessNumber=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return res.redirect('/');
  });

  app.get('/api/conversations', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, '/api/conversations', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/conversations/:customer/messages', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/messages`, 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/read', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/read`, 'POST');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/mark-unread', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/mark-unread`, 'POST');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/messages/:messageId', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/messages/${encodeURIComponent(req.params.messageId)}`, 'DELETE');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/conversations/:customer', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}`, 'DELETE');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/send', (req, res, next) => {
    const body = {
      text: req.body?.text ?? '',
      draftMediaIds: Array.isArray(req.body?.draftMediaIds) ? req.body.draftMediaIds : []
    };
    proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/send`, 'POST', body)
      .then(result => res.status(result.status).json(result.data))
      .catch(next);
  });

  // ── Draft media (pre-upload of attachments before send) ─────────────────

  app.post('/api/drafts/:customer/media', (req, res, next) => {
    const business = getBusinessNumberFromSession(req);
    if (!business) return res.status(401).json({ error: 'Not logged in' });

    const targetUrl = new URL(
      `/api/drafts/${encodeURIComponent(req.params.customer)}/media`,
      config.ECHO_SERVICE_BASE_URL
    );
    targetUrl.searchParams.set('businessNumber', String(business));

    // Strip browser-only headers — this is a server-to-server call, so the
    // user's Origin/Referer/Cookie shouldn't travel through or EchoService
    // will reject them via CORS.
    const {
      origin: _o, referer: _r, cookie: _c, host: _h,
      ...forwardHeaders
    } = req.headers;
    forwardHeaders.host = targetUrl.host;

    const transport = targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(targetUrl, {
      method: 'POST',
      headers: forwardHeaders
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => { next(err); });
    req.pipe(proxyReq);
  });

  app.get('/api/drafts/:customer/media', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/drafts/${encodeURIComponent(req.params.customer)}/media`, 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  app.delete('/api/drafts/:customer/media/:draftMediaId', async (req, res, next) => {
    try {
      const result = await proxyEchoService(
        config,
        req,
        `/api/drafts/${encodeURIComponent(req.params.customer)}/media/${encodeURIComponent(req.params.draftMediaId)}`,
        'DELETE'
      );
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  // ── Settings page ──────────────────────────────────────────────────────────

  app.get('/api/me', (req, res) => {
    const business = getBusinessNumberFromSession(req);
    if (!business) return res.status(401).json({ error: 'Not logged in' });
    return res.json({ iBusinessNumber: business });
  });

  app.get('/settings', (req, res) => {
    const business = getBusinessNumberFromSession(req);
    if (!business) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'settings.html'));
  });

  // ── Settings API proxies ───────────────────────────────────────────────────

  app.get('/api/carriers', async (req, res, next) => {
    try {
      const result = await proxyDirect(config, req, '/api/carriers', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  app.get('/api/carrier-applications', async (req, res, next) => {
    try {
      const result = await proxyDirect(config, req, '/api/carrier-applications', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  app.get('/api/carrier-applications/:id', async (req, res, next) => {
    try {
      const result = await proxyDirect(config, req, `/api/carrier-applications/${encodeURIComponent(req.params.id)}`, 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  app.post('/api/carrier-applications', async (req, res, next) => {
    try {
      const result = await proxyDirect(config, req, '/api/carrier-applications', 'POST', req.body);
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  app.put('/api/carrier-applications/:id', async (req, res, next) => {
    try {
      const result = await proxyDirect(config, req, `/api/carrier-applications/${encodeURIComponent(req.params.id)}`, 'PUT', req.body);
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  // Business-phone routes always scope to the logged-in session number.
  app.get('/api/business-phones', async (req, res, next) => {
    try {
      const business = getBusinessNumberFromSession(req);
      if (!business) return res.status(401).json({ error: 'Not logged in' });
      const result = await proxyDirect(config, req, `/api/business-phones/${business}`, 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  app.post('/api/business-phones', async (req, res, next) => {
    try {
      const business = getBusinessNumberFromSession(req);
      if (!business) return res.status(401).json({ error: 'Not logged in' });
      const result = await proxyDirect(config, req, '/api/business-phones', 'POST', {
        ...req.body,
        iBusinessNumber: business
      });
      return res.status(result.status).json(result.data);
    } catch (error) { next(error); }
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
