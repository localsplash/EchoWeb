import { describe, it, expect } from 'vitest';
import type express from 'express';
import { parseCrmClient, checkLoginState } from './auth';
import { buildAuthorizeUrl } from './idClient';

describe('parseCrmClient', () => {
  it('extracts a 10-digit hostedPulseNumber from the attributes array', () => {
    const info = parseCrmClient({
      id: 7,
      firstName: 'Ada',
      lastName: 'Lovelace',
      attributes: [{ key: 'hostedPulseNumber', value: '(555) 123-4567' }],
      contacts: [{ email: 'ada@example.com', isBilling: true }],
    });
    expect(info).toEqual({
      clientId: '7',
      hostedPulseNumber: '5551234567',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
    });
  });

  it('treats a malformed number as absent rather than guessing', () => {
    const info = parseCrmClient({
      id: 7,
      attributes: [{ key: 'hostedPulseNumber', value: '12345' }],
    });
    expect(info.hostedPulseNumber).toBeNull();
  });

  it('prefers the billing contact, then any contact', () => {
    const info = parseCrmClient({
      id: 1,
      contacts: [
        { email: 'other@example.com', isContact: true },
        { email: 'billing@example.com', isBilling: true },
      ],
    });
    expect(info.email).toBe('billing@example.com');
  });

  it('prefers companyName over the personal name', () => {
    const info = parseCrmClient({ id: 1, companyName: 'Acme', firstName: 'Ada' });
    expect(info.displayName).toBe('Acme');
  });
});

describe('checkLoginState', () => {
  function reqWithCookie(cookie?: string): express.Request {
    return { headers: cookie ? { cookie } : {} } as unknown as express.Request;
  }

  it('accepts when the returned state matches the cookie', () => {
    expect(checkLoginState(reqWithCookie('echo_login_state=abc123'), 'abc123')).toBe(true);
  });

  it('rejects a mismatch or a missing cookie', () => {
    expect(checkLoginState(reqWithCookie('echo_login_state=abc123'), 'zzz')).toBe(false);
    expect(checkLoginState(reqWithCookie(), 'abc123')).toBe(false);
  });

  it("accepts the special 'sso' state for id-initiated entries", () => {
    // Straight from the ISP portal there was no prior round trip, so no
    // cookie can exist — id marks these with state=sso.
    expect(checkLoginState(reqWithCookie(), 'sso')).toBe(true);
  });
});

describe('buildAuthorizeUrl', () => {
  it('targets id/authorize with redirect_uri and state', () => {
    const url = new URL(
      buildAuthorizeUrl('https://id.wisp.net', 'https://echo.wisp.net/auth/callback', 's-1')
    );
    expect(url.origin + url.pathname).toBe('https://id.wisp.net/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://echo.wisp.net/auth/callback');
    expect(url.searchParams.get('state')).toBe('s-1');
  });
});
