import crypto from 'crypto';
import mysql from 'mysql2/promise';
import { AppConfig } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionRow {
  sSessionId: string;
  iUserId: number | null;
  iOrgId: number | null;
  iBusinessNumber: number | null;
  role: 'owner' | 'admin' | 'member' | null;
  bIsSuperAdmin: boolean;
  bIsProvisioning: boolean;
  jsonMeta: Record<string, unknown> | null;
  dtExpires: Date;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  email_verified: boolean;
  hd?: string; // hosted domain (Workspace accounts only)
}

/**
 * What the login flow actually needs from an OAuth provider, so the callback
 * logic can be shared rather than duplicated per provider.
 */
export interface OAuthUserInfo {
  sub: string;
  email: string;
  name: string;
  /** Verified domain, when the provider vouches for one (Google Workspace `hd`). */
  hd?: string;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

const SESSION_COOKIE = 'echo_session';
const OAUTH_STATE_COOKIE = 'echo_oauth_state';
const SESSION_TTL_DAYS = 30;
const SUPERADMIN_TTL_HOURS = 8;

export function generateId(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function toMySQLDateTime(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

export async function createSession(
  pool: mysql.Pool,
  params: {
    iUserId?: number;
    iOrgId?: number;
    iBusinessNumber?: number | null;
    role?: 'owner' | 'admin' | 'member';
    bIsSuperAdmin?: boolean;
    bIsProvisioning?: boolean;
    jsonMeta?: Record<string, unknown>;
    ttlMinutes?: number;
  }
): Promise<string> {
  const sessionId = generateId(32);
  const ttlMs = (params.ttlMinutes ?? SESSION_TTL_DAYS * 24 * 60) * 60 * 1000;
  const expires = new Date(Date.now() + ttlMs);

  await pool.query(
    `INSERT INTO auth_tbl_Session
       (sSessionId, iUserId, iOrgId, iBusinessNumber, role,
        bIsSuperAdmin, bIsProvisioning, jsonMeta, dtExpires)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      params.iUserId ?? null,
      params.iOrgId ?? null,
      params.iBusinessNumber ?? null,
      params.role ?? null,
      params.bIsSuperAdmin ? 1 : 0,
      params.bIsProvisioning ? 1 : 0,
      params.jsonMeta ? JSON.stringify(params.jsonMeta) : null,
      toMySQLDateTime(expires),
    ]
  );
  return sessionId;
}

export async function getSession(
  pool: mysql.Pool,
  sessionId: string
): Promise<SessionRow | null> {
  if (!sessionId || !/^[0-9a-f]{64}$/.test(sessionId)) return null;

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT sSessionId, iUserId, iOrgId, iBusinessNumber, role,
            bIsSuperAdmin, bIsProvisioning, jsonMeta, dtExpires
     FROM auth_tbl_Session
     WHERE sSessionId = ? AND dtExpires > NOW(3)`,
    [sessionId]
  );

  if (!rows.length) return null;

  const r = rows[0];
  return {
    sSessionId: r.sSessionId as string,
    iUserId: r.iUserId as number | null,
    iOrgId: r.iOrgId as number | null,
    iBusinessNumber: r.iBusinessNumber as number | null,
    role: r.role as 'owner' | 'admin' | 'member' | null,
    bIsSuperAdmin: Boolean(r.bIsSuperAdmin),
    bIsProvisioning: Boolean(r.bIsProvisioning),
    jsonMeta: r.jsonMeta
      ? (typeof r.jsonMeta === 'string' ? JSON.parse(r.jsonMeta) : r.jsonMeta)
      : null,
    dtExpires: new Date(r.dtExpires as string),
  };
}

export async function updateSessionBusinessNumber(
  pool: mysql.Pool,
  sessionId: string,
  iBusinessNumber: number
): Promise<void> {
  await pool.query(
    `UPDATE auth_tbl_Session SET iBusinessNumber = ? WHERE sSessionId = ?`,
    [iBusinessNumber, sessionId]
  );
}

export async function deleteSession(pool: mysql.Pool, sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM auth_tbl_Session WHERE sSessionId = ?`, [sessionId]);
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function setSessionCookie(
  res: import('express').Response,
  sessionId: string,
  expiresAt?: Date
): void {
  const maxAge = expiresAt
    ? Math.floor((expiresAt.getTime() - Date.now()) / 1000)
    : SESSION_TTL_DAYS * 24 * 3600;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`
  );
}

export function clearSessionCookie(res: import('express').Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
  );
}

export function getSessionIdFromRequest(req: import('express').Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

/** Login providers that go through the OAuth redirect dance. */
export type OAuthProvider = 'google' | 'microsoft';

export interface OAuthState {
  csrf: string;
  /** 'link' attaches the returning identity to an already-signed-in user. */
  context: 'login' | 'link' | 'superadmin';
  /**
   * Which provider this state was minted for. Both flows share one state
   * cookie, so each callback checks this and refuses a state belonging to the
   * other — otherwise an abandoned "link Google" attempt would silently turn a
   * later Microsoft sign-in into a link against that stale session.
   */
  provider: OAuthProvider;
  linkSessionId?: string;
  returnTo?: string;
}

export function buildGoogleAuthUrl(config: AppConfig, state: OAuthState): string {
  const stateParam = Buffer.from(JSON.stringify(state)).toString('base64url');
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: `${config.APP_BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: stateParam,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function setOAuthStateCookie(
  res: import('express').Response,
  state: OAuthState
): string {
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64url');
  res.setHeader(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=${encoded}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax; Secure`
  );
  return encoded;
}

export function clearOAuthStateCookie(res: import('express').Response): void {
  res.setHeader(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
  );
}

export function getOAuthStateFromRequest(
  req: import('express').Request
): OAuthState | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === OAUTH_STATE_COOKIE) {
      try {
        return JSON.parse(
          Buffer.from(decodeURIComponent(v.join('=')), 'base64url').toString('utf8')
        );
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function exchangeGoogleCode(
  config: AppConfig,
  code: string
): Promise<{ access_token: string; id_token: string } | null> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${config.APP_BASE_URL}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) return null;
  return resp.json() as Promise<{ access_token: string; id_token: string }>;
}

export async function getGoogleUserInfo(
  accessToken: string
): Promise<GoogleUserInfo | null> {
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  return resp.json() as Promise<GoogleUserInfo>;
}

// ─── Microsoft (Entra ID) OAuth ───────────────────────────────────────────────

function microsoftAuthority(config: AppConfig): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.MICROSOFT_TENANT)}`;
}

export function microsoftRedirectUri(config: AppConfig): string {
  return `${config.APP_BASE_URL}/auth/microsoft/callback`;
}

export function buildMicrosoftAuthUrl(config: AppConfig, state: OAuthState): string {
  const stateParam = Buffer.from(JSON.stringify(state)).toString('base64url');
  const params = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID,
    redirect_uri: microsoftRedirectUri(config),
    response_type: 'code',
    // openid+profile+email is all we need; no Graph scopes, so no admin consent.
    scope: 'openid profile email',
    state: stateParam,
    response_mode: 'query',
    prompt: 'select_account',
  });
  return `${microsoftAuthority(config)}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeMicrosoftCode(
  config: AppConfig,
  code: string
): Promise<{ access_token: string; id_token: string } | null> {
  const resp = await fetch(`${microsoftAuthority(config)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.MICROSOFT_CLIENT_ID,
      client_secret: config.MICROSOFT_CLIENT_SECRET,
      redirect_uri: microsoftRedirectUri(config),
      grant_type: 'authorization_code',
      scope: 'openid profile email',
    }),
  });
  if (!resp.ok) return null;
  return resp.json() as Promise<{ access_token: string; id_token: string }>;
}

interface MicrosoftIdTokenClaims {
  sub?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the signed-in user out of the id_token.
 *
 * The token comes straight back from Microsoft's token endpoint over TLS, on a
 * request authenticated with our client secret, so the claims are trustworthy
 * without verifying the signature locally — the same trust model as the Google
 * path's direct call to the userinfo endpoint.
 *
 * NOTE: Entra's `email` claim is set by the user's own tenant and is not proof
 * of address ownership the way Google's is. Echo matches CRM contacts on this
 * address (see provisionFromCrmClient), which means a tenant administrator can
 * in principle claim an org by setting a user's email to a subscriber's contact
 * address. Accepted deliberately; revisit by requiring the `xms_edov` optional
 * claim if orgs ever need stricter control.
 */
export function parseMicrosoftIdToken(idToken: string): OAuthUserInfo | null {
  const claims = decodeJwtPayload(idToken) as MicrosoftIdTokenClaims | null;
  if (!claims?.sub) return null;

  // `preferred_username` is the UPN for work/school accounts and the address
  // for personal ones; `email` is only present when the tenant publishes it.
  const candidate = claims.email ?? claims.preferred_username ?? '';
  const email = candidate.includes('@') ? candidate.toLowerCase() : '';
  if (!email) return null;

  return { sub: claims.sub, email, name: claims.name ?? email };
}

// ─── UISP SSO one-time code ───────────────────────────────────────────────────

interface SsoPayload {
  clientId: string;
  nonce: string;
  exp: number; // unix timestamp (seconds)
}

export function verifySsoCode(
  config: AppConfig,
  code: string,
  sig: string
): SsoPayload | null {
  // Constant-time HMAC comparison
  const expected = crypto
    .createHmac('sha256', config.UISP_SSO_SECRET)
    .update(code)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(sig, 'hex');
  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return null;
  }

  let payload: SsoPayload;
  try {
    payload = JSON.parse(
      Buffer.from(code, 'base64url').toString('utf8')
    ) as SsoPayload;
  } catch {
    return null;
  }

  if (!payload.clientId || !payload.nonce || !payload.exp) return null;
  if (Math.floor(Date.now() / 1000) > payload.exp) return null; // expired

  return payload;
}

/** Returns false if nonce was already used (replay). */
export async function consumeNonce(
  pool: mysql.Pool,
  nonce: string,
  expUnix: number
): Promise<boolean> {
  const exp = new Date(expUnix * 1000);
  // Attempt insert; if already present, the INSERT fails and we know it's a replay.
  try {
    await pool.query(
      `INSERT INTO auth_tbl_SsoNonce (sNonce, dtExpires) VALUES (?, ?)`,
      [nonce, toMySQLDateTime(exp)]
    );
    return true; // first use
  } catch {
    return false; // duplicate key = replay
  }
}

// ─── UISP CRM API ─────────────────────────────────────────────────────────────

export interface UispClientInfo {
  clientId: string;
  hostedPulseNumber: string | null; // 10-digit phone number or null
  email: string | null;
  displayName: string | null;
}

type CrmContact = { email: string; name?: string; isBilling?: boolean; isContact?: boolean };

function parseCrmClient(data: Record<string, unknown>): UispClientInfo {
  // hostedPulseNumber arrives in the custom attributes array as { key, value, … }.
  // The attribute is typed integer in CRM, so coerce rather than assume a string.
  let hostedPulseNumber: string | null = null;
  const attrs = (data.attributes as Array<{ key: string; value: string }>) ?? [];
  for (const attr of attrs) {
    if (attr.key === 'hostedPulseNumber') {
      const raw = String(attr.value ?? '').replace(/\D/g, '');
      if (raw.length === 10) hostedPulseNumber = raw;
      break;
    }
  }

  const firstName = data.firstName as string | null;
  const lastName = data.lastName as string | null;
  const companyName = data.companyName as string | null;
  const displayName =
    companyName ??
    (firstName || lastName ? `${firstName ?? ''} ${lastName ?? ''}`.trim() : null);

  const contacts = (data.contacts as CrmContact[]) ?? [];
  const primary =
    contacts.find((c) => c.isBilling) ??
    contacts.find((c) => c.isContact) ??
    contacts[0] ??
    null;

  return {
    clientId: String(data.id ?? ''),
    hostedPulseNumber,
    email: primary?.email ?? null,
    displayName,
  };
}

export async function fetchUispClient(
  config: AppConfig,
  clientId: string
): Promise<UispClientInfo | null> {
  const url = `${config.UISP_BASE_URL}/crm/api/v1.0/clients/${encodeURIComponent(clientId)}`;
  const resp = await fetch(url, {
    headers: {
      'X-Auth-App-Key': config.UISP_CRM_APP_KEY_READ,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) return null;

  const data = (await resp.json()) as Record<string, unknown>;
  return { ...parseCrmClient(data), clientId };
}

/**
 * Look up a CRM client by contact email.
 *
 * Distinguishes "no such contact" (null) from "could not ask" (throws), because
 * the caller routes those to very different places — sign-up versus an error.
 */
export async function findUispClientByEmail(
  config: AppConfig,
  email: string
): Promise<UispClientInfo | null> {
  const url = `${config.UISP_BASE_URL}/crm/api/v1.0/clients?email=${encodeURIComponent(email)}`;
  const resp = await fetch(url, {
    headers: {
      'X-Auth-App-Key': config.UISP_CRM_APP_KEY_READ,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`CRM client lookup failed: ${resp.status}`);

  const list = (await resp.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(list) || !list.length) return null;

  const parsed = list.map(parseCrmClient);
  // An address could appear on more than one client; a provisioned one is the
  // more useful match, so prefer it over an arbitrary first hit.
  return parsed.find((c) => c.hostedPulseNumber) ?? parsed[0];
}

// ─── Identity / org management ────────────────────────────────────────────────

/** Upsert the org row; returns { iOrgId, isNew }. */
export async function upsertOrg(
  pool: mysql.Pool,
  uispClientId: string,
  // Null while a CRM client exists but has no hostedPulseNumber yet — they are
  // a real org that simply hasn't got a number, and must not be lost.
  iBusinessNumber: number | null,
  displayName: string | null
): Promise<{ iOrgId: number; isNew: boolean }> {
  // Try to find existing
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iOrgId FROM auth_tbl_Org WHERE uisp_client_id = ?`,
    [uispClientId]
  );

  if (rows.length) {
    // Update business number + displayName in case they changed
    await pool.query(
      `UPDATE auth_tbl_Org
         SET iBusinessNumber = COALESCE(?, iBusinessNumber),
             displayName     = COALESCE(?, displayName)
       WHERE uisp_client_id = ?`,
      [iBusinessNumber, displayName, uispClientId]
    );
    return { iOrgId: rows[0].iOrgId as number, isNew: false };
  }

  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO auth_tbl_Org (uisp_client_id, iBusinessNumber, displayName)
     VALUES (?, ?, ?)`,
    [uispClientId, iBusinessNumber, displayName]
  );
  return { iOrgId: result.insertId, isNew: true };
}

export async function findUserByIdentity(
  pool: mysql.Pool,
  provider: string,
  subject: string
): Promise<number | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iUserId FROM auth_tbl_Identity WHERE provider = ? AND subject = ?`,
    [provider, subject]
  );
  return rows.length ? (rows[0].iUserId as number) : null;
}

export async function findUserByEmail(
  pool: mysql.Pool,
  email: string
): Promise<number | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iUserId FROM auth_tbl_User WHERE email = ? LIMIT 1`,
    [email]
  );
  return rows.length ? (rows[0].iUserId as number) : null;
}

// ─── Identity management ──────────────────────────────────────────────────────

export interface IdentityRow {
  iIdentityId: number;
  iUserId: number;
  provider: 'google' | 'magic_link' | 'uisp' | 'microsoft';
  subject: string;
  email: string | null;
  dtCreated: string;
}

export async function listIdentities(
  pool: mysql.Pool,
  iUserId: number
): Promise<IdentityRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iIdentityId, iUserId, provider, subject, email, dtCreated
       FROM auth_tbl_Identity
      WHERE iUserId = ?
      ORDER BY FIELD(provider,'uisp','google','microsoft','magic_link'), dtCreated ASC`,
    [iUserId]
  );
  return rows as unknown as IdentityRow[];
}

export async function getIdentity(
  pool: mysql.Pool,
  iIdentityId: number
): Promise<IdentityRow | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iIdentityId, iUserId, provider, subject, email, dtCreated
       FROM auth_tbl_Identity WHERE iIdentityId = ?`,
    [iIdentityId]
  );
  return rows.length ? (rows[0] as unknown as IdentityRow) : null;
}

export async function deleteIdentity(pool: mysql.Pool, iIdentityId: number): Promise<void> {
  await pool.query(`DELETE FROM auth_tbl_Identity WHERE iIdentityId = ?`, [iIdentityId]);
}

/**
 * Removing a user's only identity would lock them out with no way back in, so
 * unlinking is refused at that point regardless of who is asking.
 */
export async function countIdentities(pool: mysql.Pool, iUserId: number): Promise<number> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) n FROM auth_tbl_Identity WHERE iUserId = ?`,
    [iUserId]
  );
  return Number(rows[0]?.n ?? 0);
}

// ─── Super-admin overview ─────────────────────────────────────────────────────

export interface AdminAccountView {
  iOrgId: number | null;
  uispClientId: string | null;
  iBusinessNumber: number | null;
  orgName: string | null;
  users: Array<{
    iUserId: number;
    email: string | null;
    displayName: string | null;
    role: string | null;
    status: string | null;
    identities: Array<{
      iIdentityId: number;
      provider: string;
      subject: string;
      email: string | null;
      dtCreated: string;
    }>;
  }>;
}

/** Every org with its members and their identities, plus any orphaned users. */
export async function adminListAccounts(pool: mysql.Pool): Promise<AdminAccountView[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT o.iOrgId, o.uisp_client_id, o.iBusinessNumber, o.displayName AS orgName,
            u.iUserId, u.email, u.displayName AS userName,
            m.role, m.status,
            i.iIdentityId, i.provider, i.subject, i.email AS identityEmail, i.dtCreated
       FROM auth_tbl_Org o
       LEFT JOIN auth_tbl_Membership m ON m.iOrgId  = o.iOrgId
       LEFT JOIN auth_tbl_User       u ON u.iUserId = m.iUserId
       LEFT JOIN auth_tbl_Identity   i ON i.iUserId = u.iUserId
      ORDER BY o.iOrgId, u.iUserId, FIELD(i.provider,'uisp','google','microsoft','magic_link')`
  );

  const orgs = new Map<number, AdminAccountView>();
  for (const r of rows) {
    const orgId = r.iOrgId as number;
    if (!orgs.has(orgId)) {
      orgs.set(orgId, {
        iOrgId: orgId,
        uispClientId: (r.uisp_client_id as string) ?? null,
        iBusinessNumber: (r.iBusinessNumber as number) ?? null,
        orgName: (r.orgName as string) ?? null,
        users: [],
      });
    }
    const org = orgs.get(orgId)!;
    if (r.iUserId == null) continue;

    let user = org.users.find((u) => u.iUserId === r.iUserId);
    if (!user) {
      user = {
        iUserId: r.iUserId as number,
        email: (r.email as string) ?? null,
        displayName: (r.userName as string) ?? null,
        role: (r.role as string) ?? null,
        status: (r.status as string) ?? null,
        identities: [],
      };
      org.users.push(user);
    }
    if (r.iIdentityId != null) {
      user.identities.push({
        iIdentityId: r.iIdentityId as number,
        provider: r.provider as string,
        subject: r.subject as string,
        email: (r.identityEmail as string) ?? null,
        dtCreated: String(r.dtCreated),
      });
    }
  }

  // Users with no membership would otherwise be invisible — surface them so a
  // half-finished provisioning can actually be seen and cleaned up.
  const [orphans] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT u.iUserId, u.email, u.displayName AS userName,
            i.iIdentityId, i.provider, i.subject, i.email AS identityEmail, i.dtCreated
       FROM auth_tbl_User u
       LEFT JOIN auth_tbl_Identity i ON i.iUserId = u.iUserId
      WHERE NOT EXISTS (SELECT 1 FROM auth_tbl_Membership m WHERE m.iUserId = u.iUserId)
      ORDER BY u.iUserId`
  );

  if (orphans.length) {
    const view: AdminAccountView = {
      iOrgId: null, uispClientId: null, iBusinessNumber: null,
      orgName: null, users: [],
    };
    for (const r of orphans) {
      let user = view.users.find((u) => u.iUserId === r.iUserId);
      if (!user) {
        user = {
          iUserId: r.iUserId as number,
          email: (r.email as string) ?? null,
          displayName: (r.userName as string) ?? null,
          role: null, status: null, identities: [],
        };
        view.users.push(user);
      }
      if (r.iIdentityId != null) {
        user.identities.push({
          iIdentityId: r.iIdentityId as number,
          provider: r.provider as string,
          subject: r.subject as string,
          email: (r.identityEmail as string) ?? null,
          dtCreated: String(r.dtCreated),
        });
      }
    }
    orgs.set(-1, view);
  }

  return Array.from(orgs.values());
}

export async function createUser(
  pool: mysql.Pool,
  email: string | null,
  displayName: string | null
): Promise<number> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO auth_tbl_User (email, displayName) VALUES (?, ?)`,
    [email, displayName]
  );
  return result.insertId;
}

export async function ensureIdentity(
  pool: mysql.Pool,
  iUserId: number,
  provider: string,
  subject: string,
  email: string | null = null
): Promise<void> {
  // Refresh the address on re-login so a renamed Google account doesn't keep
  // showing its old label, but never overwrite a known one with null.
  await pool.query(
    `INSERT INTO auth_tbl_Identity (iUserId, provider, subject, email)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email = COALESCE(VALUES(email), email)`,
    [iUserId, provider, subject, email]
  );
}

export async function getOwnerMembership(
  pool: mysql.Pool,
  iOrgId: number
): Promise<{ iUserId: number; role: string } | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iUserId, role FROM auth_tbl_Membership
     WHERE iOrgId = ? AND role = 'owner' AND status = 'active'
     LIMIT 1`,
    [iOrgId]
  );
  if (!rows.length) return null;
  return { iUserId: rows[0].iUserId as number, role: rows[0].role as string };
}

export async function createMembership(
  pool: mysql.Pool,
  iUserId: number,
  iOrgId: number,
  role: 'owner' | 'admin' | 'member'
): Promise<void> {
  await pool.query(
    `INSERT IGNORE INTO auth_tbl_Membership (iUserId, iOrgId, role, status)
     VALUES (?, ?, ?, 'active')`,
    [iUserId, iOrgId, role]
  );
}

// ─── Session factories ────────────────────────────────────────────────────────

export async function createSuperAdminSession(pool: mysql.Pool, iUserId: number): Promise<string> {
  return createSession(pool, {
    iUserId,
    bIsSuperAdmin: true,
    ttlMinutes: SUPERADMIN_TTL_HOURS * 60,
  });
}

export async function createFullSession(
  pool: mysql.Pool,
  params: {
    iUserId: number;
    iOrgId: number;
    /** Null for an org awaiting a number; such a session is routed to /order-echo. */
    iBusinessNumber: number | null;
    role: 'owner' | 'admin' | 'member';
  }
): Promise<string> {
  return createSession(pool, {
    ...params,
    ttlMinutes: SESSION_TTL_DAYS * 24 * 60,
  });
}

// ─── The identity service ────────────────────────────────────────────────────

/** What identity's POST /api/token gives back. Mirrors its published contract. */
export interface IdentityClaim {
  user: {
    iUserId: number;
    email: string | null;
    displayName: string | null;
    superAdmin: boolean;
  };
  identity: { provider: string | null; subject: string | null };
  identities: Array<{ provider: string; subject: string; email: string | null }>;
}

/**
 * Redeem a one-time handoff code for the person behind it.
 *
 * Server to server, never through the browser: the code is worthless without
 * the client secret, and the answer never passes through anything the user
 * controls. identity admits this call by either its caller's IP being inside
 * `trustedCIDR` or a matching `IDENTITY_CLIENT_SECRET` — this app is on a
 * container network that is not inside that CIDR, so it presents the secret.
 *
 * Codes are single-use, expire in five minutes, and are bound to the exact
 * `redirect_uri` they were minted for, which is why that has to be passed back
 * rather than reconstructed loosely.
 *
 * Returns null on any refusal. The caller turns that into an auth error rather
 * than a stack trace, because every failure here looks the same to the person
 * signing in: it did not work, try again.
 */
export async function redeemIdentityCode(
  config: AppConfig,
  code: string,
  redirectUri: string
): Promise<IdentityClaim | null> {
  if (!config.IDENTITY_BASE_URL) return null;
  const url = new URL('/api/token', config.IDENTITY_BASE_URL);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.IDENTITY_CLIENT_SECRET) {
    headers['X-Client-Secret'] = config.IDENTITY_CLIENT_SECRET;
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code,
        redirect_uri: redirectUri,
        // Some deployments read the secret from the body instead of a header;
        // sending both costs nothing and removes a mode to get wrong.
        client_secret: config.IDENTITY_CLIENT_SECRET || undefined,
      }),
    });
    if (!resp.ok) return null;
    const claim = (await resp.json()) as IdentityClaim;
    return claim?.identity ? claim : null;
  } catch {
    return null;
  }
}
