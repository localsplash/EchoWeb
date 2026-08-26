import { buildApp } from './app';
import { loadConfig } from './config';
import { getDb } from './db';
import { IdClient, registerWithId, fetchEventsSince } from './idClient';
import {
  setWebhookSecret,
  readCursor,
  writeCursor,
  applyIdEvent,
  type IdEvent,
} from './idEvents';

const config = loadConfig();
const app = buildApp();

/**
 * Announce ourselves to id and catch up on anything missed.
 *
 * Registration is what makes this app visible in id's integration
 * dashboard, and it returns the secret that verifies deliveries — so until
 * it succeeds, the receiver refuses events rather than trusting them. It is
 * retried because id may still be starting; nothing else waits on it.
 */
async function startIdIntegration(attempt = 1): Promise<void> {
  const db = getDb(config);
  const idClient = new IdClient(config);
  try {
    const settings = await idClient.getSettings();
    const idBase = await idClient.idBaseUrl();
    const clientSecret = settings.ID_CLIENT_SECRET;
    if (!clientSecret) throw new Error('oAuthConfig ID_CLIENT_SECRET is not set');

    const webhookUrl = `${config.APP_BASE_URL.replace(/\/+$/, '')}/id/events`;
    const { secret } = await registerWithId(idBase, {
      clientSecret,
      name: 'EchoWeb',
      webhookUrl,
    });
    setWebhookSecret(secret);
    console.log(`[id-events] registered ${webhookUrl} with ${idBase}`);

    // Retries cover a brief outage; this covers a long one. Handlers are
    // idempotent, so replaying an event we already saw is harmless.
    const since = await readCursor(db);
    const missed = await fetchEventsSince(idBase, clientSecret, since);
    for (const event of missed) {
      await applyIdEvent(db, event as IdEvent, (m) => console.log(m));
      await writeCursor(db, event.id);
    }
    if (missed.length) console.log(`[id-events] caught up on ${missed.length} missed event(s)`);
  } catch (err) {
    const delay = Math.min(60_000, 2 ** attempt * 1000);
    console.warn(
      `[id-events] integration not established (attempt ${attempt}): ${String(err)} — retrying in ${delay / 1000}s`
    );
    setTimeout(() => void startIdIntegration(attempt + 1), delay).unref();
  }
}

app.listen(config.PORT, () => {
  console.log(`EchoWeb listening on :${config.PORT}`);
  void startIdIntegration();
});
