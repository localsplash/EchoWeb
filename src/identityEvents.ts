import crypto from "crypto";
import express from "express";
import type { AppConfig } from "./config";
import { identityRequest } from "./platformSession";

/**
 * Identity's application integration: Echo registers one webhook at boot and
 * Identity pushes signed events to it. Until an app registers, Identity lists
 * it as "Not integrated".
 *
 * Echo keeps no copy of a session: every request introspects the Identity
 * app session, so a revocation already takes effect on the next request and
 * merged or relinked users are resolved by Identity itself. Handling an event
 * is therefore only verifying and acknowledging it, which is idempotent by
 * construction, and there is nothing to catch up from GET /api/events.
 */

export const IDENTITY_EVENTS_PATH = "/id/events";
const TOLERANCE_SECONDS = 300;
const RETRY_DELAY_MS = 60_000;

/** The signing secret Identity returned at registration; null until then. */
let webhookSecret: string | null = null;

export function webhookUrl(config: AppConfig): string {
  return new URL(IDENTITY_EVENTS_PATH, config.APP_BASE_URL).toString();
}

/** POST /api/apps/register; keeps the returned secret for verifying deliveries. */
export async function registerWithIdentity(config: AppConfig): Promise<void> {
  const body = await identityRequest(config, "/api/apps/register", {
    name: "Echo",
    webhook_url: webhookUrl(config),
  });
  if (typeof body?.secret !== "string" || !body.secret)
    throw new Error("Identity registration returned no signing secret");
  webhookSecret = body.secret;
}

/**
 * Register at boot and, while Identity is unreachable or refuses, try again
 * every minute: without the secret no delivery can be verified, and Identity
 * keeps retrying those until one is acknowledged.
 */
export function startIdentityRegistration(
  getConfig: () => Promise<AppConfig>,
  log: Pick<Console, "log" | "error"> = console,
): void {
  const attempt = async () => {
    try {
      const config = await getConfig();
      await registerWithIdentity(config);
      log.log(`[identity] webhook registered: ${webhookUrl(config)}`);
    } catch (err) {
      log.error(
        `[identity] webhook registration failed, retrying in ${RETRY_DELAY_MS / 1000}s: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      setTimeout(attempt, RETRY_DELAY_MS).unref();
    }
  };
  void attempt();
}

/** HMAC-SHA256(secret, `${timestamp}.${rawBody}`), compared in constant time. */
export function signatureIsValid(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  const expected = Buffer.from(
    "sha256=" +
      crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest("hex"),
  );
  const presented = Buffer.from(signature);
  return (
    presented.length === expected.length &&
    crypto.timingSafeEqual(presented, expected)
  );
}

/**
 * POST /id/events. Mounted ahead of the JSON parser and the same-origin
 * check: the signature covers the raw bytes, and Identity is not a browser.
 */
export function registerIdentityEventsRoute(
  app: express.Express,
  logger: { info: (obj: object, msg: string) => void },
): void {
  app.post(
    IDENTITY_EVENTS_PATH,
    express.raw({ type: "*/*", limit: "64kb" }),
    (req, res) => {
      // 503 rather than 401: Identity retries, and registration will land.
      if (!webhookSecret)
        return res
          .status(503)
          .json({ error: "Not registered with Identity yet" });
      const timestamp = req.get("X-Id-Timestamp") ?? "";
      const signature = req.get("X-Id-Signature") ?? "";
      const sentAt = Number(timestamp);
      if (
        !/^\d+$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - sentAt) > TOLERANCE_SECONDS
      )
        return res.status(401).json({ error: "Stale or missing timestamp" });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!signatureIsValid(webhookSecret, timestamp, raw, signature))
        return res.status(401).json({ error: "Invalid signature" });
      let event: { id?: unknown; type?: unknown };
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid event" });
      }
      if (typeof event.id !== "number" || typeof event.type !== "string")
        return res.status(400).json({ error: "Invalid event" });
      logger.info({ eventId: event.id, type: event.type }, "identity event");
      return res.json({ ok: true });
    },
  );
}

/** Test seam. */
export function setWebhookSecretForTesting(secret: string | null): void {
  webhookSecret = secret;
}
