import express from 'express';
import pinoHttp from 'pino-http';
import pino from 'pino';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { loadConfig } from './config';
import { inboundPayloadSchema, sendMessageSchema } from './schemas';
import { InboundStorage } from './storage';
import { BandwidthClient } from './bandwidthClient';

export function buildApp() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const app = express();
  const storage = new InboundStorage(config.INBOUND_STORAGE_DIR);
  const bandwidth = new BandwidthClient(config);

  void storage.init();

  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Echo SMS Tester</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}
    input,textarea,button{width:100%;padding:10px;margin:8px 0;font-size:14px}
    button{cursor:pointer}
    pre{background:#111;color:#0f0;padding:12px;overflow:auto;white-space:pre-wrap}
  </style>
</head>
<body>
  <h1>Echo SMS Tester</h1>
  <p>POSTs to <code>/sendMessage</code> and shows provider response/error.</p>
  <label>From</label>
  <input id="from" value="+17149799911" />
  <label>To</label>
  <input id="to" placeholder="+1..." />
  <label>Text</label>
  <textarea id="text" rows="4">Echo is alive; from Clawdy</textarea>
  <button id="send">Send Message</button>
  <pre id="out">Ready.</pre>
<script>
document.getElementById('send').addEventListener('click', async () => {
  const out = document.getElementById('out');
  out.textContent = 'Sending...';
  try {
    const payload = {
      from: document.getElementById('from').value.trim(),
      to: document.getElementById('to').value.trim(),
      text: document.getElementById('text').value
    };
    const res = await fetch('/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    out.textContent = JSON.stringify({ status: res.status, data }, null, 2);
  } catch (e) {
    out.textContent = String(e);
  }
});
</script>
</body>
</html>`);
  });

  app.post('/callbacks/inbound/messaging', async (req, res) => {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Payload must be an array' });
    }

    let stored = 0;
    let duplicates = 0;
    let invalid = 0;

    for (const item of req.body) {
      const parsed = inboundPayloadSchema.element.safeParse(item);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }

      const id = parsed.data.message.id;
      const result = await storage.saveIfNew(id, item);
      if (result === 'stored') stored += 1;
      else duplicates += 1;
    }

    return res.json({ stored, duplicates, invalid });
  });

  app.get('/message/list', async (_req, res, next) => {
    try {
      const items = await storage.list();
      res.json({ items });
    } catch (error) {
      next(error);
    }
  });

  app.get('/message/open', async (req, res, next) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'id query parameter is required' });

    try {
      const payload = await storage.open(id);
      res.json(payload);
    } catch {
      res.status(404).json({ error: 'Message not found' });
    }
  });

  app.post('/sendMessage', async (req, res) => {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const data = await bandwidth.sendMessage(parsed.data);
      return res.json({ ok: true, provider: data });
    } catch (error: any) {
      return res.status(502).json({
        ok: false,
        error: 'Provider send failed',
        details: error?.response?.data ?? error?.message
      });
    }
  });

  const openapi = YAML.load(`${process.cwd()}/openapi.yaml`);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
