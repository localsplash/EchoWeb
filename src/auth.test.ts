import { describe, it, expect } from 'vitest';
import { buildMicrosoftAuthUrl, parseMicrosoftIdToken } from './auth';
import type { AppConfig } from './config';
import type { OAuthState } from './auth';

/** Build an unsigned JWT with the given claims — only the payload is read. */
function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature`;
}

const config = {
  MICROSOFT_CLIENT_ID: 'client-abc',
  MICROSOFT_TENANT: 'common',
  APP_BASE_URL: 'https://echo.example.com',
} as AppConfig;

describe('parseMicrosoftIdToken', () => {
  it('reads a work/school account', () => {
    const info = parseMicrosoftIdToken(
      idToken({
        sub: 'sub-123',
        oid: 'oid-456',
        tid: 'tenant-789',
        name: 'Ada Lovelace',
        email: 'ada@contoso.com',
        preferred_username: 'ada@contoso.com',
      })
    );
    expect(info).toEqual({
      sub: 'sub-123',
      email: 'ada@contoso.com',
      name: 'Ada Lovelace',
      tenantId: 'tenant-789',
    });
  });

  it('falls back to preferred_username when the tenant publishes no email claim', () => {
    const info = parseMicrosoftIdToken(
      idToken({ sub: 's', tid: 't', name: 'Bob', preferred_username: 'bob@contoso.com' })
    );
    expect(info?.email).toBe('bob@contoso.com');
  });

  it('lowercases the address so CRM lookups match regardless of casing', () => {
    const info = parseMicrosoftIdToken(idToken({ sub: 's', email: 'Ada@Contoso.COM' }));
    expect(info?.email).toBe('ada@contoso.com');
  });

  it('names the user by address when the token carries no display name', () => {
    const info = parseMicrosoftIdToken(idToken({ sub: 's', email: 'ada@contoso.com' }));
    expect(info?.name).toBe('ada@contoso.com');
  });

  // Without an address the CRM lookup would be meaningless, so the sign-in has
  // to fail rather than fall through to a blank-email provisioning attempt.
  it('rejects a token with no usable address', () => {
    expect(parseMicrosoftIdToken(idToken({ sub: 's', tid: 't', name: 'No Mail' }))).toBeNull();
  });

  it('rejects a preferred_username that is not an address', () => {
    expect(parseMicrosoftIdToken(idToken({ sub: 's', preferred_username: 'DOMAIN\\user' }))).toBeNull();
  });

  it('rejects a token with no subject', () => {
    expect(parseMicrosoftIdToken(idToken({ email: 'ada@contoso.com' }))).toBeNull();
  });

  it('rejects a malformed token instead of throwing', () => {
    expect(parseMicrosoftIdToken('not-a-jwt')).toBeNull();
    expect(parseMicrosoftIdToken('a.!!!not-base64!!!.c')).toBeNull();
  });
});

describe('buildMicrosoftAuthUrl', () => {
  const state: OAuthState = { csrf: 'csrf-token', context: 'login', provider: 'microsoft' };

  it('targets the configured authority and our own callback', () => {
    const url = new URL(buildMicrosoftAuthUrl(config, state));
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    );
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://echo.example.com/auth/microsoft/callback'
    );
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('round-trips the state so the callback can verify CSRF and provider', () => {
    const url = new URL(buildMicrosoftAuthUrl(config, state));
    const decoded = JSON.parse(
      Buffer.from(url.searchParams.get('state')!, 'base64url').toString('utf8')
    );
    expect(decoded).toEqual(state);
  });

  it('honours a tenant-restricted authority', () => {
    const url = new URL(
      buildMicrosoftAuthUrl({ ...config, MICROSOFT_TENANT: 'tenant-guid' } as AppConfig, state)
    );
    expect(url.pathname).toBe('/tenant-guid/oauth2/v2.0/authorize');
  });
});
