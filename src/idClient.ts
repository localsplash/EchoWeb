import { AppConfig } from './config';

/**
 * Client for the `id` identity processor and the shared oAuthConfig table.
 *
 * Login is not Echo's job any more: the browser is sent to
 * `id.<parent-domain>/authorize`, and Echo redeems the returned one-time
 * code here, server-to-server. The settings both sides need — where id
 * lives (APP_BASE_URL in oAuthConfig), the exchange secret, UISP CRM access
 * for provisioning — are read from the same NocoDB table id maintains, so
 * every app under the domain shares one configuration.
 */

export interface SharedSettings {
  /** oAuthConfig values, e.g. APP_BASE_URL (id's public base), ID_CLIENT_SECRET. */
  [key: string]: string;
}

interface NocoRow {
  Id: number;
  Key: string;
  Value: string | null;
}

const CACHE_TTL_MS = 30_000;

export class IdClient {
  private tableId: string | null = null;
  private cache: { at: number; settings: SharedSettings } | null = null;

  constructor(private config: AppConfig) {}

  private async nocoApi<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.config.NOCODB_BASE_URL}${path}`, {
      headers: { 'xc-token': this.config.NOCODB_API_TOKEN },
    });
    if (!resp.ok) {
      throw new Error(`NocoDB GET ${path} failed: ${resp.status}`);
    }
    return resp.json() as Promise<T>;
  }

  private async resolveTableId(): Promise<string> {
    if (this.tableId) return this.tableId;
    const bases = await this.nocoApi<{ list: Array<{ id: string; title: string }> }>(
      '/api/v2/meta/bases'
    );
    const base = bases.list.find((b) => b.title === this.config.NOCODB_BASE_NAME);
    if (!base) throw new Error(`NocoDB base '${this.config.NOCODB_BASE_NAME}' not found`);
    const tables = await this.nocoApi<{ list: Array<{ id: string; title: string }> }>(
      `/api/v2/meta/bases/${base.id}/tables`
    );
    const table = tables.list.find((t) => t.title === this.config.NOCODB_TABLE_NAME);
    if (!table) throw new Error(`NocoDB table '${this.config.NOCODB_TABLE_NAME}' not found`);
    this.tableId = table.id;
    return table.id;
  }

  /** Shared settings, cached briefly. Throws when NocoDB is unreachable. */
  async getSettings(): Promise<SharedSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.settings;
    const tableId = await this.resolveTableId();
    const settings: SharedSettings = {};
    let offset = 0;
    for (;;) {
      const page = await this.nocoApi<{
        list: NocoRow[];
        pageInfo?: { isLastPage?: boolean };
      }>(`/api/v2/tables/${tableId}/records?limit=200&offset=${offset}`);
      for (const r of page.list) {
        if (r.Key && r.Value != null && String(r.Value).trim() !== '') {
          settings[r.Key] = String(r.Value).trim();
        }
      }
      if (page.list.length < 200 || page.pageInfo?.isLastPage !== false) break;
      offset += 200;
    }
    this.cache = { at: Date.now(), settings };
    return settings;
  }

  /** Public base URL of the id app (APP_BASE_URL in oAuthConfig). */
  async idBaseUrl(): Promise<string> {
    const settings = await this.getSettings();
    const base = settings.APP_BASE_URL;
    if (!base) throw new Error('oAuthConfig APP_BASE_URL (id base URL) is not set');
    return base.replace(/\/+$/, '');
  }
}

// ─── id round trip ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(idBase: string, redirectUri: string, state: string): string {
  const url = new URL('/authorize', idBase);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface IdTokenResult {
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
 * Redeem a one-time handoff code. Returns null for a code id refuses
 * (expired, replayed, wrong redirect_uri); throws when id cannot be reached
 * or the apps disagree on the secret — those are operational failures, not
 * a user problem.
 */
export async function exchangeCode(
  idBase: string,
  params: { code: string; redirectUri: string; clientSecret: string }
): Promise<IdTokenResult | null> {
  const resp = await fetch(`${idBase}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: params.code,
      redirect_uri: params.redirectUri,
      client_secret: params.clientSecret,
    }),
  });
  if (resp.status === 400) return null;
  if (!resp.ok) throw new Error(`id token exchange failed: ${resp.status}`);
  return resp.json() as Promise<IdTokenResult>;
}

// ─── Integration handshake ────────────────────────────────────────────────────

export interface RegistrationResult {
  origin: string;
  secret: string;
  events: string[];
}

/**
 * Announce this app and its receiver endpoint to id, returning the secret
 * that signs deliveries to us.
 *
 * Called on boot: the integration is established by running, so there is no
 * separate credential to configure and no way to deploy an app that quietly
 * fails to listen — id records a registration or flags its absence.
 */
export async function registerWithId(
  idBase: string,
  params: { clientSecret: string; name: string; webhookUrl: string }
): Promise<RegistrationResult> {
  const resp = await fetch(`${idBase}/api/apps/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_secret: params.clientSecret,
      name: params.name,
      webhook_url: params.webhookUrl,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`id registration failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<RegistrationResult>;
}

/** Events after `since` — the boot-time catch-up for anything missed. */
export async function fetchEventsSince(
  idBase: string,
  clientSecret: string,
  since: number
): Promise<Array<{ id: number; type: string; occurredAt: string; data: Record<string, unknown> }>> {
  const url = new URL('/api/events', idBase);
  url.searchParams.set('since', String(since));
  const resp = await fetch(url, { headers: { 'X-Id-Client-Secret': clientSecret } });
  if (!resp.ok) throw new Error(`id event catch-up failed: ${resp.status}`);
  const body = (await resp.json()) as { items?: Array<Record<string, unknown>> };
  return (body.items ?? []) as Array<{
    id: number;
    type: string;
    occurredAt: string;
    data: Record<string, unknown>;
  }>;
}
