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
