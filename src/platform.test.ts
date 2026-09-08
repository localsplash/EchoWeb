import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from './app';
import { setConfigForTesting, loadConfig, type AppConfig } from './config';
import type { PlatformIdentity } from './platformSession';
const fake = vi.hoisted(() => ({
  queries: [] as string[],
  mappings: [] as Record<string, unknown>[],
}));
vi.mock('./db', () => ({
  getDb: () => ({
    query: async (sql: string) => {
      fake.queries.push(sql);
      throw new Error('Identity authorization must not query Echo tables');
    },
  }),
}));
const token = 'a'.repeat(64),
  rootToken = 'b'.repeat(64),
  origin = 'https://echo.x.tld';
let sessions: Map<string, PlatformIdentity>,
  calls: Array<{ url: URL; body: Record<string, unknown> }>;
const cookie = (t = token, n?: number) =>
  `__Host-echo_platform_session=${t}${n ? `; echo_business=${n}` : ''}`;
beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'silent');
  fake.queries = [];
  fake.mappings = [
    {
      iOrgId: 1,
      iTenantId: 11,
      iBusinessNumber: 7145550001,
      currentNumber: 7145550001,
    },
    {
      iOrgId: 2,
      iTenantId: 22,
      iBusinessNumber: 7145550002,
      currentNumber: 7145550002,
    },
  ];
  const tenants = [
    {
      iTenantId: 11,
      name: 'First office',
      slug: 'first',
      role: 'TENANT_ADMIN' as const,
      bEnabled: true,
    },
    {
      iTenantId: 22,
      name: 'Second office',
      slug: 'second',
      role: 'USER' as const,
      bEnabled: true,
    },
  ];
  sessions = new Map([
    [
      token,
      {
        active: true,
        numbers: fake.mappings
          .filter((m) => m.iTenantId === 11)
          .map((m, i) => ({
            iPhoneNumberId: i + 1,
            iTenantId: Number(m.iTenantId),
            phoneNumber: `+1${m.iBusinessNumber}`,
            label: '',
            bVoice: true,
            bMessaging: true,
            bEnabled: true,
            accessPolicy: 'TENANT_MEMBERS' as const,
            iVersion: 1,
          })),
        user: {
          iUserId: 91,
          email: 'user@x.tld',
          displayName: 'User',
          superAdmin: false,
        },
        tenants: [tenants[0]],
        selectedTenantId: 11,
      },
    ],
    [
      rootToken,
      {
        active: true,
        numbers: fake.mappings.map((m, i) => ({
          iPhoneNumberId: i + 1,
          iTenantId: Number(m.iTenantId),
          phoneNumber: `+1${m.iBusinessNumber}`,
          label: '',
          bVoice: true,
          bMessaging: true,
          bEnabled: true,
          accessPolicy: 'TENANT_MEMBERS' as const,
          iVersion: 1,
        })),
        user: {
          iUserId: 92,
          email: 'staff@x.tld',
          displayName: 'Staff',
          superAdmin: true,
        },
        tenants: tenants.map((t) => ({ ...t, role: 'SUPER_ADMIN' as const })),
        selectedTenantId: 22,
      },
    ],
  ]);
  setConfigForTesting({
    APP_BASE_URL: origin,
    IDENTITY_BASE_URL: 'https://identity.x.tld',
    IDENTITY_CLIENT_SECRET: 'trusted-server',
    ECHO_SERVICE_BASE_URL: 'http://echo-service:3000',
  } as AppConfig);
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(input),
        body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });
      const json = (value: unknown) => ({
        ok: true,
        status: 200,
        json: async () => value,
      });
      if (url.pathname === '/api/sessions/introspect')
        return json(sessions.get(body.token) ?? { active: false });
      if (url.pathname === '/api/sessions/revoke') {
        sessions.delete(body.token);
        return json({ revoked: true });
      }
      if (url.pathname === '/api/sessions/select-tenant') {
        const session = sessions.get(body.token)!;
        if (
          !session.tenants.some(
            (t) => t.bEnabled && t.iTenantId === body.iTenantId,
          )
        )
          return { ok: false, status: 403 };
        session.selectedTenantId = body.iTenantId;
        return json({ selectedTenantId: body.iTenantId });
      }
      if (url.hostname === 'echo-service') return json({ items: [], ok: true });
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('Echo central authorization boundary', () => {
  it('starts shared SSO automatically and leaves logout/error pages accessible', async () => {
    const app = buildApp();
    expect((await request(app).get('/')).headers.location).toBe(
      '/auth/identity',
    );
    expect((await request(app).get('/?signed_out=1')).status).toBe(200);
    expect((await request(app).get('/?auth_error=denied')).status).toBe(200);
  });
  it('admits ordinary members without legacy records and shows a warning when no numbers exist', async () => {
    fake.mappings = [];
    sessions.get(token)!.tenants[0].role = 'USER';
    expect(
      (await request(buildApp()).get('/api/me').set('Cookie', cookie())).body
        .iBusinessNumber,
    ).toBe(7145550001);
    expect(fake.queries).toEqual([]);
    sessions.get(token)!.numbers = [];
    const result = await request(buildApp())
      .get('/choose-business')
      .set('Cookie', cookie());
    expect(result.status).toBe(200);
    expect(result.text).toContain('Please speak to your Tenant Admin');
    expect(
      (
        await request(buildApp())
          .get('/api/conversations')
          .set('Cookie', cookie())
      ).status,
    ).toBe(403);
  });
  it('uses the public Identity origin only for browser sign-in', async () => {
    setConfigForTesting({
      ...loadConfig(),
      IDENTITY_BASE_URL: 'http://identity-preview:3200',
      IDENTITY_PUBLIC_BASE_URL: 'https://identity-preview.x.tld',
    });
    const app = buildApp();
    const login = await request(app).get('/auth/identity');
    expect(new URL(login.headers.location).origin).toBe(
      'https://identity-preview.x.tld',
    );
    expect(
      (await request(app).get('/api/me').set('Cookie', cookie())).status,
    ).toBe(200);
    expect(calls.at(-1)?.url.origin).toBe('http://identity-preview:3200');
    for (const path of [
      '/auth/link',
      '/internal/accounts',
      '/sso/callback?code=x&sig=y',
    ]) {
      const response = await request(app).get(path);
      expect(new URL(response.headers.location).origin).toBe(
        'https://identity-preview.x.tld',
      );
    }
    const identities = await request(app).get('/api/identities');
    expect(new URL(identities.body.manageUrl).origin).toBe(
      'https://identity-preview.x.tld',
    );
    setConfigForTesting({
      ...loadConfig(),
      IDENTITY_PUBLIC_BASE_URL: undefined,
    });
    const fallback = await request(app).get('/auth/identity');
    expect(new URL(fallback.headers.location).origin).toBe(
      'http://identity-preview:3200',
    );
  });
  it('publishes a same-origin media route without exposing its private origin', async () => {
    setConfigForTesting({
      ...loadConfig(),
      MEDIA_INTERNAL_BASE_URL: 'http://echo-media:8082',
      MEDIA_BASE_URL: 'https://legacy-media.x.tld',
    });
    const response = await request(buildApp()).get('/config.js');
    expect(response.text).toContain('"MEDIA_BASE_URL":"/api/media"');
    expect(response.text).not.toContain('echo-media');
    expect(response.text).not.toContain('legacy-media');
  });
  it('ignores legacy sessions and returns current central user identifiers', async () => {
    const app = buildApp();
    expect(
      (await request(app).get('/api/me').set('Cookie', `echo_session=${token}`))
        .status,
    ).toBe(401);
    const me = await request(app).get('/api/me').set('Cookie', cookie());
    expect(me.body).toMatchObject({
      iUserId: 91,
      iTenantId: 11,
      iOrgId: null,
      isSuperAdmin: false,
      iBusinessNumber: 7145550001,
    });
    expect(
      fake.queries.every(
        (sql) =>
          !sql.includes('auth_tbl_Session') &&
          !sql.includes('auth_tbl_Membership'),
      ),
    ).toBe(true);
  });
  it('binds the business number server-side and denies forged cross-tenant number preferences', async () => {
    const app = buildApp();
    const result = await request(app)
      .get('/api/conversations?businessNumber=7145550002')
      .set('Cookie', cookie());
    expect(result.status).toBe(200);
    expect(calls.at(-1)?.url.searchParams.get('businessNumber')).toBe(
      '7145550001',
    );
    expect(
      (
        await request(app)
          .get('/api/conversations')
          .set('Cookie', cookie(token, 7145550002))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/select-business')
          .set('Origin', origin)
          .set('Cookie', cookie())
          .send({ businessNumber: 7145550002 })
      ).status,
    ).toBe(403);
  });
  it('takes role changes, tenant disablement and central revocation into account on the next request', async () => {
    const app = buildApp();
    expect(
      (await request(app).get('/api/conversations').set('Cookie', cookie()))
        .status,
    ).toBe(200);
    sessions.get(token)!.tenants = [];
    expect(
      (await request(app).get('/api/conversations').set('Cookie', cookie()))
        .status,
    ).toBe(403);
    sessions.delete(token);
    expect(
      (await request(app).get('/api/me').set('Cookie', cookie())).status,
    ).toBe(401);
  });
  it('lets verified SUPER_ADMIN select mapped businesses and denies carrier access to ordinary users', async () => {
    const app = buildApp();
    const result = await request(app)
      .get('/api/businesses')
      .set('Cookie', cookie(rootToken));
    expect(result.body.items).toHaveLength(2);
    expect(
      (
        await request(app)
          .post('/select-business')
          .set('Origin', origin)
          .set('Cookie', cookie(rootToken))
          .send({ businessNumber: 7145550001 })
      ).status,
    ).toBe(302);
    expect(sessions.get(rootToken)!.selectedTenantId).toBe(11);
    expect(
      (
        await request(app)
          .get('/api/carrier-applications')
          .set('Cookie', cookie())
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/carrier-applications')
          .set('Cookie', cookie(rootToken))
      ).status,
    ).toBe(200);
  });
  it('rejects cookie-authenticated cross-origin and missing-origin mutations', async () => {
    const app = buildApp();
    for (const headers of [{}, { Origin: 'https://evil.x.tld' }])
      expect(
        (
          await request(app)
            .post('/logout')
            .set(headers)
            .set('Cookie', cookie())
        ).status,
      ).toBe(403);
    expect(sessions.has(token)).toBe(true);
    expect(
      (
        await request(app)
          .post('/logout')
          .set('Origin', origin)
          .set('Cookie', cookie())
      ).status,
    ).toBe(302);
    expect(sessions.has(token)).toBe(false);
  });
  it('fails closed on Identity outage and changed historical number mappings', async () => {
    const app = buildApp();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(
      (await request(app).get('/api/conversations').set('Cookie', cookie()))
        .status,
    ).toBe(503);
    expect(fake.queries).toHaveLength(0);
  });
  it('ignores legacy mapping drift and keeps the canonical number bound', async () => {
    fake.mappings[0].currentNumber = 7145550099;
    const result = await request(buildApp())
      .get('/api/conversations')
      .set('Cookie', cookie());
    expect(result.status).toBe(200);
    expect(calls.at(-1)?.url.searchParams.get('businessNumber')).toBe(
      '7145550001',
    );
    expect(fake.queries).toEqual([]);
  });
  it('completes a state-bound central login without local person or session provisioning', async () => {
    const original = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        if (new URL(input).pathname === '/api/token')
          return {
            ok: true,
            json: async () => ({
              appSession: { token },
              user: sessions.get(token)!.user,
              identity: { provider: 'uisp', subject: 'crm-person' },
              identities: [],
            }),
          };
        return original(input, init);
      }),
    );
    const csrf = 'c'.repeat(32),
      state = Buffer.from(
        JSON.stringify({ csrf, context: 'login', provider: 'google' }),
      ).toString('base64url');
    const response = await request(buildApp())
      .get(`/auth/identity/callback?code=valid&state=${csrf}`)
      .set('Cookie', `echo_oauth_state=${state}`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(
      (response.headers['set-cookie'] as unknown as string[]).some((c) =>
        c.startsWith(`__Host-echo_platform_session=${token}`),
      ),
    ).toBe(true);
    expect(
      fake.queries.length === 0,
    ).toBe(true);
  });
  it('does not redeem unsolicited or mismatched callback state', async () => {
    const app = buildApp();
    expect(
      (await request(app).get('/auth/identity/callback?code=x&state=sso'))
        .headers.location,
    ).toBe('/auth/identity');
    expect(
      (await request(app).get('/auth/identity/callback?code=x&state=wrong'))
        .headers.location,
    ).toContain('auth_error=state');
    expect(calls).toHaveLength(0);
  });
});
