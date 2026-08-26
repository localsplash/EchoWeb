import crypto from 'crypto';
import mysql from 'mysql2/promise';

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
  dtExpires: Date | null; // null = never expires (revocation only)
}

// ─── Session helpers ──────────────────────────────────────────────────────────

const SESSION_COOKIE = 'echo_session';
const LOGIN_STATE_COOKIE = 'echo_login_state';
// Sessions persist until revoked; the cookie still needs a finite Max-Age.
const SESSION_COOKIE_MAX_AGE = 10 * 365 * 24 * 3600;

export function generateId(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
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
  }
): Promise<string> {
  const sessionId = generateId(32);

  await pool.query(
    `INSERT INTO auth_tbl_Session
       (sSessionId, iUserId, iOrgId, iBusinessNumber, role,
        bIsSuperAdmin, bIsProvisioning, jsonMeta, dtExpires)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      sessionId,
      params.iUserId ?? null,
      params.iOrgId ?? null,
      params.iBusinessNumber ?? null,
      params.role ?? null,
      params.bIsSuperAdmin ? 1 : 0,
      params.bIsProvisioning ? 1 : 0,
      params.jsonMeta ? JSON.stringify(params.jsonMeta) : null,
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
     WHERE sSessionId = ? AND (dtExpires IS NULL OR dtExpires > NOW(3))`,
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
    dtExpires: r.dtExpires ? new Date(r.dtExpires as string) : null,
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

// Appends rather than overwrites, so a login-state clear and a session set
// can share one response.
function appendCookie(res: import('express').Response, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev.map(String) : [String(prev)]) : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

export function setSessionCookie(res: import('express').Response, sessionId: string): void {
  appendCookie(
    res,
    `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`
  );
}

export function clearSessionCookie(res: import('express').Response): void {
  appendCookie(
    res,
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

// ─── Login round-trip state (CSRF for the id redirect) ────────────────────────

/**
 * Before sending the browser to id/authorize we drop a random state in a
 * cookie; the callback requires the query state to match it. The one
 * exception is state=sso — an unsolicited entry id initiates itself (e.g.
 * the user came straight from the ISP portal), where no cookie can exist.
 */
export function setLoginStateCookie(res: import('express').Response, state: string): void {
  appendCookie(
    res,
    `${LOGIN_STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`
  );
}

export function clearLoginStateCookie(res: import('express').Response): void {
  appendCookie(
    res,
    `${LOGIN_STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
  );
}

export function getLoginStateFromRequest(req: import('express').Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === LOGIN_STATE_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function checkLoginState(
  req: import('express').Request,
  returnedState: string
): boolean {
  if (returnedState === 'sso') return true; // unsolicited SSO entry from id
  const stored = getLoginStateFromRequest(req);
  return Boolean(stored) && stored === returnedState;
}

// ─── UISP CRM API ─────────────────────────────────────────────────────────────

/** Comes from the shared oAuthConfig table, not the environment. */
export interface CrmConfig {
  UISP_BASE_URL: string;
  UISP_CRM_APP_KEY_READ: string;
}

export interface UispClientInfo {
  clientId: string;
  hostedPulseNumber: string | null; // 10-digit phone number or null
  email: string | null;
  displayName: string | null;
}

type CrmContact = { email: string; name?: string; isBilling?: boolean; isContact?: boolean };

export function parseCrmClient(data: Record<string, unknown>): UispClientInfo {
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
  crm: CrmConfig,
  clientId: string
): Promise<UispClientInfo | null> {
  const url = `${crm.UISP_BASE_URL}/crm/api/v1.0/clients/${encodeURIComponent(clientId)}`;
  const resp = await fetch(url, {
    headers: {
      'X-Auth-App-Key': crm.UISP_CRM_APP_KEY_READ,
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
  crm: CrmConfig,
  email: string
): Promise<UispClientInfo | null> {
  const url = `${crm.UISP_BASE_URL}/crm/api/v1.0/clients?email=${encodeURIComponent(email)}`;
  const resp = await fetch(url, {
    headers: {
      'X-Auth-App-Key': crm.UISP_CRM_APP_KEY_READ,
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
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iOrgId FROM auth_tbl_Org WHERE uisp_client_id = ?`,
    [uispClientId]
  );

  if (rows.length) {
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

/**
 * Echo users are projections of id users: the id app owns who a person is
 * (and their login methods); Echo only records which org they belong to.
 */
export async function findUserByIdUserId(
  pool: mysql.Pool,
  iIdUserId: number
): Promise<number | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iUserId FROM auth_tbl_User WHERE iIdUserId = ?`,
    [iIdUserId]
  );
  return rows.length ? (rows[0].iUserId as number) : null;
}

export async function createUser(
  pool: mysql.Pool,
  iIdUserId: number,
  email: string | null,
  displayName: string | null
): Promise<number> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO auth_tbl_User (iIdUserId, email, displayName) VALUES (?, ?, ?)`,
    [iIdUserId, email, displayName]
  );
  return result.insertId;
}

/** Find-or-create the Echo projection of an id user. */
export async function ensureUser(
  pool: mysql.Pool,
  iIdUserId: number,
  email: string | null,
  displayName: string | null
): Promise<number> {
  const existing = await findUserByIdUserId(pool, iIdUserId);
  if (existing) {
    // Keep the label fresh, but never blank out a known one.
    await pool.query(
      `UPDATE auth_tbl_User
          SET email = COALESCE(?, email), displayName = COALESCE(?, displayName)
        WHERE iUserId = ?`,
      [email, displayName, existing]
    );
    return existing;
  }
  return createUser(pool, iIdUserId, email, displayName);
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

export async function findActiveMembership(
  pool: mysql.Pool,
  iUserId: number
): Promise<{ iOrgId: number; role: 'owner' | 'admin' | 'member'; iBusinessNumber: number | null } | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT m.iOrgId, m.role, o.iBusinessNumber
       FROM auth_tbl_Membership m
       INNER JOIN auth_tbl_Org o ON o.iOrgId = m.iOrgId
      WHERE m.iUserId = ? AND m.status = 'active'
      ORDER BY FIELD(m.role,'owner','admin','member'), m.dtCreated ASC
      LIMIT 1`,
    [iUserId]
  );
  if (!rows.length) return null;
  return {
    iOrgId: rows[0].iOrgId as number,
    role: rows[0].role as 'owner' | 'admin' | 'member',
    iBusinessNumber: (rows[0].iBusinessNumber as number) ?? null,
  };
}

// ─── Super-admin overview ─────────────────────────────────────────────────────

export interface AdminAccountView {
  iOrgId: number | null;
  uispClientId: string | null;
  iBusinessNumber: number | null;
  orgName: string | null;
  users: Array<{
    iUserId: number;
    iIdUserId: number | null;
    email: string | null;
    displayName: string | null;
    role: string | null;
    status: string | null;
  }>;
}

/**
 * Every org with its members, plus any orphaned users. Login methods are not
 * listed here any more — identities belong to the id app, whose admin
 * console is the place to inspect or unlink them.
 */
export async function adminListAccounts(pool: mysql.Pool): Promise<AdminAccountView[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT o.iOrgId, o.uisp_client_id, o.iBusinessNumber, o.displayName AS orgName,
            u.iUserId, u.iIdUserId, u.email, u.displayName AS userName,
            m.role, m.status
       FROM auth_tbl_Org o
       LEFT JOIN auth_tbl_Membership m ON m.iOrgId  = o.iOrgId
       LEFT JOIN auth_tbl_User       u ON u.iUserId = m.iUserId
      ORDER BY o.iOrgId, u.iUserId`
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

    org.users.push({
      iUserId: r.iUserId as number,
      iIdUserId: (r.iIdUserId as number) ?? null,
      email: (r.email as string) ?? null,
      displayName: (r.userName as string) ?? null,
      role: (r.role as string) ?? null,
      status: (r.status as string) ?? null,
    });
  }

  // Users with no membership would otherwise be invisible — surface them so a
  // half-finished provisioning can actually be seen and cleaned up.
  const [orphans] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT u.iUserId, u.iIdUserId, u.email, u.displayName AS userName
       FROM auth_tbl_User u
      WHERE NOT EXISTS (SELECT 1 FROM auth_tbl_Membership m WHERE m.iUserId = u.iUserId)
      ORDER BY u.iUserId`
  );

  if (orphans.length) {
    orgs.set(-1, {
      iOrgId: null, uispClientId: null, iBusinessNumber: null, orgName: null,
      users: orphans.map((r) => ({
        iUserId: r.iUserId as number,
        iIdUserId: (r.iIdUserId as number) ?? null,
        email: (r.email as string) ?? null,
        displayName: (r.userName as string) ?? null,
        role: null,
        status: null,
      })),
    });
  }

  return Array.from(orgs.values());
}

// ─── Session factories ────────────────────────────────────────────────────────

export async function createSuperAdminSession(pool: mysql.Pool, iUserId: number): Promise<string> {
  return createSession(pool, { iUserId, bIsSuperAdmin: true });
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
  return createSession(pool, params);
}
