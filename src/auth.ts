import crypto from 'crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from './config';

const SESSION_COOKIE = '__Host-echo_platform_session';
const OAUTH_STATE_COOKIE = 'echo_oauth_state';
export interface OAuthState {
  csrf: string;
  context: 'login';
  provider: 'google';
  returnTo?: string;
}
export function generateId(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}
function cookie(req: Request, name: string): string | null {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}
export function getSessionIdFromRequest(req: Request): string | null {
  return cookie(req, SESSION_COOKIE);
}
export function setSessionCookie(res: Response, token: string): void {
  if (!/^[0-9a-f]{64}$/.test(token))
    throw new Error('Invalid central application token');
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`,
  );
  res.append(
    'Set-Cookie',
    'echo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
  );
}
export function clearSessionCookie(res: Response): void {
  for (const name of [SESSION_COOKIE, 'echo_session'])
    res.append(
      'Set-Cookie',
      `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );
}
export function setOAuthStateCookie(res: Response, state: OAuthState): void {
  res.append(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=${Buffer.from(JSON.stringify(state)).toString('base64url')}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
  );
}
export function clearOAuthStateCookie(res: Response): void {
  res.append(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
  );
}
export function getOAuthStateFromRequest(req: Request): OAuthState | null {
  try {
    const raw = cookie(req, OAUTH_STATE_COOKIE);
    if (!raw) return null;
    const state = JSON.parse(Buffer.from(raw, 'base64url').toString());
    return typeof state.csrf === 'string' && /^[0-9a-f]{32}$/.test(state.csrf)
      ? state
      : null;
  } catch {
    return null;
  }
}
const claimSchema = z.object({
  appSession: z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }),
  user: z.object({
    iUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
    superAdmin: z.boolean(),
  }),
  identity: z.object({
    provider: z.string().nullable(),
    subject: z.string().nullable(),
  }),
  identities: z.array(
    z.object({
      provider: z.string(),
      subject: z.string(),
      email: z.string().nullable(),
    }),
  ),
});
export type IdentityClaim = z.infer<typeof claimSchema>;
/** Identity verifies providers and issues the sole browser-session credential.
 * No Echo-local user, identity, organization, membership, or session is created. */
export async function redeemIdentityCode(
  config: AppConfig,
  code: string,
  redirectUri: string,
): Promise<IdentityClaim | null> {
  try {
    const response = await fetch(
      new URL('/api/token', config.IDENTITY_BASE_URL),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.IDENTITY_CLIENT_SECRET
            ? { 'X-Id-Client-Secret': config.IDENTITY_CLIENT_SECRET }
            : {}),
        },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      },
    );
    if (!response.ok) return null;
    const claim = claimSchema.safeParse(await response.json());
    return claim.success ? claim.data : null;
  } catch {
    return null;
  }
}
