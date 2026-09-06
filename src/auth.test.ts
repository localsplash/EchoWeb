import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  setSessionCookie,
  clearOAuthStateCookie,
  getSessionIdFromRequest,
  redeemIdentityCode,
} from './auth';
import type { AppConfig } from './config';
const token = 'a'.repeat(64);
afterEach(() => vi.unstubAllGlobals());
describe('central handoff and cookies', () => {
  it('sets a host-bound opaque cookie and clears OAuth state without overwriting headers', async () => {
    const app = express();
    app.get('/', (_req, res) => {
      clearOAuthStateCookie(res);
      setSessionCookie(res, token);
      res.end();
    });
    const res = await request(app).get('/');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toContain('echo_oauth_state=;');
    expect(cookies[1]).toContain(`__Host-echo_platform_session=${token}`);
    expect(cookies[1]).toContain('HttpOnly; SameSite=Lax; Secure');
    expect(cookies[1]).not.toContain('Domain=');
    expect(cookies[2]).toContain('echo_session=;');
  });
  it('does not adopt a legacy local session cookie', () => {
    expect(
      getSessionIdFromRequest({
        headers: { cookie: `echo_session=${token}` },
      } as express.Request),
    ).toBeNull();
    expect(
      getSessionIdFromRequest({
        headers: { cookie: '__Host-echo_platform_session=%ZZ' },
      } as express.Request),
    ).toBeNull();
  });
  it('requires a central token and strict verified privilege in the token response', async () => {
    const config = {
      IDENTITY_BASE_URL: 'https://identity.X.TLD',
      IDENTITY_CLIENT_SECRET: 'server-only',
    } as AppConfig;
    const payload = {
      appSession: { token },
      user: {
        iUserId: 7,
        email: 'x@x.tld',
        displayName: 'X',
        superAdmin: false,
      },
      identity: { provider: 'google', subject: '7' },
      identities: [],
    };
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetch);
    expect(
      (
        await redeemIdentityCode(
          config,
          'code',
          'https://echo.X.TLD/auth/identity/callback',
        )
      )?.user.superAdmin,
    ).toBe(false);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { 'X-Id-Client-Secret': 'server-only' },
    });
    payload.user.superAdmin = 'false' as unknown as boolean;
    expect(
      await redeemIdentityCode(
        config,
        'code',
        'https://echo.X.TLD/auth/identity/callback',
      ),
    ).toBeNull();
  });
});
