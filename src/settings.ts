import mysql from 'mysql2/promise';

/**
 * Where EchoWeb's configuration comes from.
 *
 * Two sources, and the split is deliberate:
 *
 *   - **`echo_tbl_Settings` in the Echo database** holds everything about
 *     this application — the OAuth and UISP credentials, the public URLs,
 *     where EchoService lives. Settings sit next to the data they describe,
 *     in the database EchoDatabase owns. Rows are keyed by `sApp`: `'*'` is
 *     read by every Echo app, `'web'` by this one, and this one's own row
 *     wins over the general one.
 *
 *   - **`trustedCIDR` in the IdentityBase NocoDB base** is the single
 *     exception, and the only thing read from outside the Echo database. It
 *     is platform-wide network policy that identity and every application
 *     have to agree on, so it is spelled once, in one place, rather than
 *     copied into each application's own settings.
 *
 * Both are cached for 30 seconds, so a change reaches a running app without a
 * restart; both drop their cache on failure, so the next attempt re-reads
 * rather than trusting something it could not confirm; and neither has a
 * fallback, because an app that cannot read its configuration should say so.
 */

/** Values are trusted for this long before the source is asked again. */
export const CACHE_TTL_MS = 30_000;

/** This application's `sApp` in `echo_tbl_Settings`. */
export const APP_NAME = 'web';

/** The NocoDB base holding the platform-wide network policy. */
export const IDENTITY_BASE_NAME = 'IdentityBase';
export const IDENTITY_TABLE_NAME = 'auth_tbl_Settings';

export type Settings = Record<string, string>;

export class SettingsUnavailableError extends Error {
  constructor(
    public reason:
      | 'unconfigured'
      | 'unreachable'
      | 'base_missing'
      | 'base_ambiguous'
      | 'table_missing',
    message: string
  ) {
    super(message);
    this.name = 'SettingsUnavailableError';
  }
}

// ─── The Echo database ────────────────────────────────────────────────────────

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

// ─── IdentityBase, for the trusted network only ──────────────────────────────

interface ResolvedIds {
  baseId: string;
  tableId: string;
}

/**
 * Reads `trustedCIDR` out of IdentityBase.
 *
 * The base is found by NAME at runtime, never by an ID from a config file: an
 * ID survives a rename and outlives a restore. Two bases with the name is a
 * configuration error rather than something to guess past.
 */
export class TrustedNetworkStore {
  private ids: { at: number; ids: ResolvedIds } | null = null;
  private cache: { at: number; value: string } | null = null;

  constructor(
    private config: { NOCODB_BASE_URL: string; NOCODB_API_TOKEN: string },
    private override = ''
  ) {}

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

  private asUnavailable(err: unknown): SettingsUnavailableError {
    if (err instanceof SettingsUnavailableError) return err;
    return new SettingsUnavailableError(
      'unreachable',
      `NocoDB at ${this.config.NOCODB_BASE_URL} did not answer or rejected the token: ` +
        String(err instanceof Error ? err.message : err).slice(0, 200)
    );
  }

  private async resolveIds(): Promise<ResolvedIds> {
    if (this.ids && Date.now() - this.ids.at < CACHE_TTL_MS) return this.ids.ids;
    if (!this.config.NOCODB_BASE_URL || !this.config.NOCODB_API_TOKEN) {
      throw new SettingsUnavailableError(
        'unconfigured',
        'NOCODB_BASE_URL and NOCODB_API_TOKEN must be set to read trustedCIDR from ' +
          `${IDENTITY_BASE_NAME}.`
      );
    }
    try {
      const bases = await this.api<{ list: Array<{ id: string; title: string }> }>(
        '/api/v2/meta/bases'
      );
      const matches = bases.list.filter((b) => b.title === IDENTITY_BASE_NAME);
      if (matches.length === 0) {
        throw new SettingsUnavailableError(
          'base_missing',
          `No NocoDB base named ${IDENTITY_BASE_NAME} at ${this.config.NOCODB_BASE_URL}. ` +
            'The base is found by name, so a renamed base looks like a missing one.'
        );
      }
      if (matches.length > 1) {
        throw new SettingsUnavailableError(
          'base_ambiguous',
          `${matches.length} NocoDB bases are named ${IDENTITY_BASE_NAME}. The name must be ` +
            'unique — this app will not guess which one carries the network policy.'
        );
      }
      const baseId = matches[0].id;
      const tables = await this.api<{ list: Array<{ id: string; title: string }> }>(
        `/api/v2/meta/bases/${baseId}/tables`
      );
      const table = tables.list.find((t) => t.title === IDENTITY_TABLE_NAME);
      if (!table) {
        throw new SettingsUnavailableError(
          'table_missing',
          `The base ${IDENTITY_BASE_NAME} has no table named ${IDENTITY_TABLE_NAME}.`
        );
      }
      const ids = { baseId, tableId: table.id };
      this.ids = { at: Date.now(), ids };
      return ids;
    } catch (err) {
      this.ids = null; // never reuse an ID we could not confirm
      throw this.asUnavailable(err);
    }
  }

  /** The trusted network, or '' when the platform has not set one. */
  async get(): Promise<string> {
    if (this.override) return this.override;
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const { tableId } = await this.resolveIds();
    try {
      const page = await this.api<{ list: Array<{ Key: string; Value: string | null }> }>(
        `/api/v2/tables/${tableId}/records?limit=200`
      );
      const row = page.list.find((r) => r.Key === 'trustedCIDR');
      const value = row && row.Value != null ? String(row.Value).trim() : '';
      this.cache = { at: Date.now(), value };
      return value;
    } catch (err) {
      this.ids = null; // the table ID may have gone stale with the base
      throw this.asUnavailable(err);
    }
  }

  invalidate(): void {
    this.cache = null;
    this.ids = null;
  }
}
