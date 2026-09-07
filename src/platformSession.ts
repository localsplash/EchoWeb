import mysql from 'mysql2/promise';
import { z } from 'zod';
import type { AppConfig } from './config';

const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const tenant = z.object({
  iTenantId: safeId,
  name: z.string(),
  slug: z.string(),
  role: z.enum(['TENANT_ADMIN', 'USER', 'SUPER_ADMIN']),
  bEnabled: z.boolean(),
});
const numberRecord = z.object({
  iPhoneNumberId: safeId,
  iTenantId: safeId,
  phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/),
  label: z.string(),
  bVoice: z.boolean(),
  bMessaging: z.boolean(),
  bEnabled: z.boolean(),
  accessPolicy: z.literal('TENANT_MEMBERS'),
  iVersion: z.number().int().positive(),
});
const active = z.object({
  active: z.literal(true),
  user: z.object({
    iUserId: safeId,
    email: z.string().nullable(),
    displayName: z.string().nullable(),
    superAdmin: z.boolean(),
  }),
  tenants: z.array(tenant),
  numbers: z.array(numberRecord),
  selectedTenantId: safeId.nullable(),
});
export type PlatformIdentity = z.infer<typeof active>;
export interface BusinessBinding {
  iOrgId: number | null;
  iTenantId: number;
  iBusinessNumber: number;
  name: string;
  role: 'TENANT_ADMIN' | 'USER' | 'SUPER_ADMIN';
}
export interface PlatformSession {
  sSessionId: string;
  iUserId: number;
  iOrgId: number | null;
  iTenantId: number | null;
  iBusinessNumber: number | null;
  role: 'TENANT_ADMIN' | 'USER' | 'SUPER_ADMIN' | null;
  bIsSuperAdmin: boolean;
  email: string | null;
  displayName: string | null;
  orgName: string | null;
  businesses: BusinessBinding[];
}
export class IdentityUnavailableError extends Error {}
export class TenantBoundaryError extends Error {}
export async function identityRequest(
  config: AppConfig,
  path: string,
  body: unknown,
) {
  try {
    const response = await fetch(new URL(path, config.IDENTITY_BASE_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.IDENTITY_CLIENT_SECRET
          ? { 'X-Id-Client-Secret': config.IDENTITY_CLIENT_SECRET }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new IdentityUnavailableError(
        `Identity rejected ${path} (${response.status})`,
      );
    return await response.json();
  } catch (e) {
    if (e instanceof IdentityUnavailableError) throw e;
    throw new IdentityUnavailableError('Identity authorization is unavailable');
  }
}
export async function introspect(
  config: AppConfig,
  token: string,
): Promise<PlatformIdentity | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const body = await identityRequest(config, '/api/sessions/introspect', {
    token,
  });
  if (body?.active === false) return null;
  const parsed = active.safeParse(body);
  if (!parsed.success)
    throw new IdentityUnavailableError(
      'Identity returned an invalid session contract',
    );
  // The super-admin flag is the sole global authority; a role label cannot elevate it.
  if (
    !parsed.data.user.superAdmin &&
    parsed.data.tenants.some((t) => t.role === 'SUPER_ADMIN')
  )
    throw new IdentityUnavailableError(
      'Inconsistent Identity privilege response',
    );
  return parsed.data;
}
/** Legacy import verification only; runtime access uses Identity numbers below. */
export async function availableBusinesses(
  db: mysql.Pool,
  identity: PlatformIdentity,
): Promise<BusinessBinding[]> {
  const allowed = identity.tenants.filter((t) => t.bEnabled);
  if (!allowed.length) return [];
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    `SELECT m.iOrgId,m.iTenantId,m.iBusinessNumber,o.iBusinessNumber AS currentNumber
    FROM echo_tbl_PlatformOrgMap m JOIN auth_tbl_Org o ON o.iOrgId=m.iOrgId
    WHERE m.iTenantId IN (?) ORDER BY m.iTenantId,m.iOrgId`,
    [allowed.map((t) => t.iTenantId)],
  );
  return rows.flatMap((row) => {
    const id = safeId.parse(Number(row.iTenantId)),
      org = safeId.parse(Number(row.iOrgId));
    const own = allowed.find((t) => t.iTenantId === id);
    if (!own) throw new TenantBoundaryError('Unexpected tenant mapping');
    if (row.iBusinessNumber == null) return [];
    const number = Number(row.iBusinessNumber);
    if (
      !/^\d{10}$/.test(String(number)) ||
      number !== Number(row.currentNumber)
    )
      throw new TenantBoundaryError(
        'Business mapping needs administrator reconciliation',
      );
    return [
      {
        iOrgId: org,
        iTenantId: id,
        iBusinessNumber: number,
        name: own.name,
        role: own.role,
      },
    ];
  });
}
export async function resolvePlatformSession(
  db: mysql.Pool,
  config: AppConfig,
  token: string,
  selectedNumber: string | null,
): Promise<PlatformSession | null> {
  const identity = await introspect(config, token);
  if (!identity) return null;
  // Central tenant-number assignments are authority. Legacy Echo user/org tables
  // retain history only; new platform members need no Echo-local user row.
  const businesses: BusinessBinding[] = identity.numbers
    .filter((n) => n.bEnabled && n.bMessaging)
    .map((n) => {
      const tenant = identity.tenants.find(
        (t) => t.iTenantId === n.iTenantId && t.bEnabled,
      );
      if (
        !tenant ||
        n.accessPolicy !== 'TENANT_MEMBERS' ||
        !/^\+1[2-9]\d{9}$/.test(n.phoneNumber)
      )
        throw new TenantBoundaryError('Invalid central number assignment');
      return {
        iOrgId: null,
        iTenantId: n.iTenantId,
        iBusinessNumber: Number(n.phoneNumber.slice(2)),
        name: n.label ? `${tenant.name} — ${n.label}` : tenant.name,
        role: tenant.role,
      };
    });
  const selected = businesses.filter(
    (b) => b.iTenantId === identity.selectedTenantId,
  );
  // A business-number cookie is only a UI preference. It is revalidated against
  // current tenant membership and immutable server-owned mappings every time.
  const business = selectedNumber
    ? selected.find((b) => String(b.iBusinessNumber) === selectedNumber)
    : selected.length === 1
      ? selected[0]
      : undefined;
  return {
    sSessionId: token,
    iUserId: identity.user.iUserId,
    iOrgId: business?.iOrgId ?? null,
    iTenantId: business?.iTenantId ?? null,
    iBusinessNumber: business?.iBusinessNumber ?? null,
    role: business?.role ?? null,
    bIsSuperAdmin: identity.user.superAdmin,
    email: identity.user.email,
    displayName: identity.user.displayName,
    orgName: business?.name ?? null,
    businesses,
  };
}
export async function selectBusiness(
  config: AppConfig,
  session: PlatformSession,
  businessNumber: number,
): Promise<BusinessBinding> {
  const binding = session.businesses.find(
    (b) => b.iBusinessNumber === businessNumber,
  );
  if (!binding)
    throw new TenantBoundaryError('Business is not available to this session');
  const response = await identityRequest(
    config,
    '/api/sessions/select-tenant',
    { token: session.sSessionId, iTenantId: binding.iTenantId },
  );
  if (response.selectedTenantId !== binding.iTenantId)
    throw new IdentityUnavailableError(
      'Identity did not confirm tenant selection',
    );
  return binding;
}
