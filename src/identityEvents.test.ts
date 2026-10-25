import crypto from "crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { buildApp } from "./app";
import { setConfigForTesting, type AppConfig } from "./config";
import {
  registerWithIdentity,
  setWebhookSecretForTesting,
  webhookUrl,
} from "./identityEvents";

vi.mock("./db", () => ({ getDb: () => ({ query: async () => [[]] }) }));

const secret = "s".repeat(64);
const config = {
  NODE_ENV: "test",
  PORT: 3160,
  LOG_LEVEL: "silent",
  NOCODB_BASE_URL: "",
  NOCODB_API_TOKEN: "",
  ECHO_SERVICE_BASE_URL: "http://echo-service-private:8080",
  MEDIA_INTERNAL_BASE_URL: "http://echo-media:8082",
  DB_HOST: "db",
  DB_PORT: 3306,
  DB_USER: "u",
  DB_PASSWORD: "p",
  DB_NAME: "echo",
  APP_BASE_URL: "https://echo.x.tld",
  UISP_PLUGIN_URL: "",
  PUSHER_KEY: "",
  PUSHER_CLUSTER: "",
  PARENT_DOMAIN: "x.tld",
  IDENTITY_CLIENT_SECRET: "",
  IDENTITY_BASE_URL: "https://identity.x.tld",
  IDENTITY_PUBLIC_BASE_URL: "https://identity.x.tld",
} satisfies AppConfig;

function signed(
  body: string,
  ts = Math.floor(Date.now() / 1000),
  key = secret,
) {
  const sig = crypto
    .createHmac("sha256", key)
    .update(`${ts}.${body}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Id-Event": "session.revoked",
    "X-Id-Event-Id": "7",
    "X-Id-Timestamp": String(ts),
    "X-Id-Signature": `sha256=${sig}`,
  };
}

const event = JSON.stringify({
  id: 7,
  type: "session.revoked",
  occurredAt: "2026-10-25T00:00:00.000Z",
  data: { iUserId: 9, scope: "all" },
});

beforeEach(() => {
  vi.stubEnv("LOG_LEVEL", "silent");
  setConfigForTesting(config);
  setWebhookSecretForTesting(secret);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setWebhookSecretForTesting(null);
});

describe("POST /id/events", () => {
  it("acknowledges a correctly signed event without an Origin header", async () => {
    const res = await request(buildApp())
      .post("/id/events")
      .set(signed(event))
      .send(event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("acknowledges a redelivery of the same event", async () => {
    const app = buildApp();
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post("/id/events")
        .set(signed(event))
        .send(event);
      expect(res.status).toBe(200);
    }
  });

  it("rejects a wrong signature", async () => {
    const res = await request(buildApp())
      .post("/id/events")
      .set(signed(event, undefined, "other"))
      .send(event);
    expect(res.status).toBe(401);
  });

  it("rejects a body changed after signing", async () => {
    const res = await request(buildApp())
      .post("/id/events")
      .set(signed(event))
      .send(event.replace('"iUserId":9', '"iUserId":1'));
    expect(res.status).toBe(401);
  });

  it("rejects a timestamp more than 300s off", async () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    const res = await request(buildApp())
      .post("/id/events")
      .set(signed(event, old))
      .send(event);
    expect(res.status).toBe(401);
  });

  it("asks Identity to retry until registration has supplied the secret", async () => {
    setWebhookSecretForTesting(null);
    const res = await request(buildApp())
      .post("/id/events")
      .set(signed(event))
      .send(event);
    expect(res.status).toBe(503);
  });
});

describe("registerWithIdentity", () => {
  it("registers APP_BASE_URL/id/events and keeps the returned secret", async () => {
    setWebhookSecretForTesting(null);
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({ ok: true, secret: "k".repeat(64) }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    await registerWithIdentity(config);
    expect(webhookUrl(config)).toBe("https://echo.x.tld/id/events");
    expect(calls).toEqual([
      {
        url: "https://identity.x.tld/api/apps/register",
        body: { name: "Echo", webhook_url: "https://echo.x.tld/id/events" },
      },
    ]);
    vi.unstubAllGlobals();
    const res = await request(buildApp())
      .post("/id/events")
      .set(signed(event, undefined, "k".repeat(64)))
      .send(event);
    expect(res.status).toBe(200);
  });
});
