import mysql from 'mysql2/promise';

/**
 * Where EchoWeb's configuration comes from.
 *
 * One source: **`echo_tbl_Settings` in the Echo database**. It holds
 * everything about this application — the OAuth and UISP credentials, the
 * public URLs, where EchoService lives. Settings sit next to the data they
 * describe, in the database EchoDatabase owns. Rows are keyed by `sApp`:
 * `'*'` is read by every Echo app, `'web'` by this one, and this one's own
 * row wins over the general one.
 *
 * There used to be a second source — `trustedCIDR`, read from the IdentityBase
 * NocoDB base. This app never used the value: it fetched it, put it on the
 * config object, and nothing read it back. What it did do was make NocoDB
 * credentials a hard requirement for starting at all, which is why a host
 * without them could not run EchoWeb. EchoService still reads that row, since
 * it genuinely enforces the network policy; this app does not, so it no longer
 * asks. See #17.
 *
 * Values are cached for 30 seconds, so a change reaches a running app without
 * a restart; the cache is dropped on failure, so the next attempt re-reads
 * rather than trusting something it could not confirm; and there is no
 * fallback, because an app that cannot read its configuration should say so.
 */

/** Values are trusted for this long before the source is asked again. */
export const CACHE_TTL_MS = 30_000;

/** This application's `sApp` in `echo_tbl_Settings`. */
export const APP_NAME = 'web';

export type Settings = Record<string, string>;

export class SettingsUnavailableError extends Error {
  constructor(
    public reason: 'unconfigured' | 'unreachable',
    message: string
  ) {
    super(message);
    this.name = 'SettingsUnavailableError';
  }
}

interface SettingRow extends mysql.RowDataPacket {
  sApp: string;
  sKey: string;
  sValue: string | null;
}

/**
 * This app's settings: the general rows, then its own on top.
 *
 * An empty value is "not set" rather than an empty string, so a blank row
 * never shadows a real value — and a `'web'` row left blank does not blank
 * out the `'*'` row underneath it.
 */
export async function readEchoSettings(
  db: mysql.Pool,
  app: string = APP_NAME
): Promise<Settings> {
  const [rows] = await db.query<SettingRow[]>(
    `SELECT sApp, sKey, sValue FROM echo_tbl_Settings
      WHERE sApp IN ('*', ?)
      ORDER BY sApp = ?`, // the app's own row sorts last, so it wins
    [app, app]
  );
  const settings: Settings = {};
  for (const row of rows) {
    if (row.sValue != null && String(row.sValue).trim() !== '') {
      settings[row.sKey] = String(row.sValue).trim();
    }
  }
  return settings;
}

// ─── IdentityBase, for what the platform decides once ────────────────────────

/**
 * Two values EchoWeb reads from the platform's own settings base rather than
 * from `echo_tbl_Settings`.
 *
 * `PARENT_DOMAIN` is the domain every application on the platform hangs off.
 * It is not an Echo setting — identity owns it, and its own hostname is
 * derived from it — so restating it here would be a second place for the two
 * to disagree. Every public URL this app has follows from it (see config.ts),
 * which is what makes moving the platform to a new domain one edit instead of
 * a hunt through rows.
 *
 * `IDENTITY_CLIENT_SECRET` is how this app authenticates to identity's
 * server-to-server token endpoint. It is identity's secret, held where
 * identity holds it.
 *
 * This is the NocoDB read that #17 removed — deliberately, because the value
 * it fetched then (`trustedCIDR`) had no consumers. These two do. The
 * credentials come from the same shared bootstrap file EchoService uses, so it
 * costs a deployment nothing: identity's `/setup` is still the only place
 * anyone types them.
 */
export const IDENTITY_BASE_NAME = 'IdentityBase';
export const IDENTITY_TABLE_NAME = 'auth_tbl_Settings';

/** The keys read from IdentityBase. Blank counts as unset, as everywhere. */
export const IDENTITY_KEYS = ['PARENT_DOMAIN', 'IDENTITY_CLIENT_SECRET'] as const;

interface NocoConfig {
  NOCODB_BASE_URL: string;
  NOCODB_API_TOKEN: string;
}

export class IdentitySettingsStore {
  private ids: { at: number; tableId: string } | null = null;
  private cache: { at: number; values: Settings } | null = null;

  constructor(private config: NocoConfig) {}

  private async api<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.config.NOCODB_BASE_URL}${path}`, {
      headers: { 'xc-token': this.config.NOCODB_API_TOKEN, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`NocoDB GET ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    return resp.json() as Promise<T>;
  }

  private async resolveTable(): Promise<string> {
    if (this.ids && Date.now() - this.ids.at < CACHE_TTL_MS) return this.ids.tableId;
    if (!this.config.NOCODB_BASE_URL || !this.config.NOCODB_API_TOKEN) {
      throw new SettingsUnavailableError(
        'unconfigured',
        'NOCODB_BASE_URL and NOCODB_API_TOKEN must be set to read PARENT_DOMAIN from ' +
          `${IDENTITY_BASE_NAME}. On a single-host install they come from identity's ` +
          'config volume, mounted read-only at /data.'
      );
    }
    // Found by NAME at runtime, never by an ID from a config file: an ID
    // survives a rename and outlives a restore.
    const bases = await this.api<{ list: Array<{ id: string; title: string }> }>(
      '/api/v2/meta/bases'
    );
    const matches = bases.list.filter((b) => b.title === IDENTITY_BASE_NAME);
    if (matches.length !== 1) {
      throw new SettingsUnavailableError(
        'unreachable',
        `Expected exactly one NocoDB base named ${IDENTITY_BASE_NAME}, found ${matches.length}.`
      );
    }
    const tables = await this.api<{ list: Array<{ id: string; title: string }> }>(
      `/api/v2/meta/bases/${matches[0].id}/tables`
    );
    const table = tables.list.find((t) => t.title === IDENTITY_TABLE_NAME);
    if (!table) {
      throw new SettingsUnavailableError(
        'unreachable',
        `The base ${IDENTITY_BASE_NAME} has no table named ${IDENTITY_TABLE_NAME}.`
      );
    }
    this.ids = { at: Date.now(), tableId: table.id };
    return table.id;
  }

  async get(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.values;
    try {
      const tableId = await this.resolveTable();
      const page = await this.api<{ list: Array<{ Key: string; Value: string | null }> }>(
        `/api/v2/tables/${tableId}/records?limit=200`
      );
      const values: Settings = {};
      for (const key of IDENTITY_KEYS) {
        const row = page.list.find((r) => r.Key === key);
        const value = row && row.Value != null ? String(row.Value).trim() : '';
        if (value) values[key] = value;
      }
      this.cache = { at: Date.now(), values };
      return values;
    } catch (err) {
      // Never reuse an ID we could not confirm.
      this.ids = null;
      if (err instanceof SettingsUnavailableError) throw err;
      throw new SettingsUnavailableError(
        'unreachable',
        `NocoDB at ${this.config.NOCODB_BASE_URL} did not answer or rejected the token: ` +
          String(err instanceof Error ? err.message : err).slice(0, 200)
      );
    }
  }

  invalidate(): void {
    this.cache = null;
    this.ids = null;
  }
}
