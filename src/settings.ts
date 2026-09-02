/**
 * Settings live in NocoDB, not in the environment.
 *
 * Every application on the platform reads the same table: the base
 * `IdentityBase` (one base per repository, named `{Repo}Base`), table
 * `auth_tbl_Settings`. See localsplash/identify#15 for the standard this
 * implements; the rules that matter here are:
 *
 *   - the base is found by NAME at runtime. A base name is unique because we
 *     say it is — NocoDB does not enforce it — and a base ID in a config file
 *     survives a rename and outlives a restore, which is the coupling the
 *     convention exists to remove;
 *   - values AND the resolved base/table IDs sit on one 30-second clock, so a
 *     change in NocoDB — a rename or a restore included — reaches a running
 *     app without a restart;
 *   - any failure drops the cache, so the next attempt re-detects rather than
 *     reusing an ID it could not confirm;
 *   - there is no fallback. An app that cannot read its configuration says so.
 *
 * Only the identity service creates this base. Here a missing base is always
 * an error: a second base appearing by accident is exactly what the
 * unique-name convention exists to prevent.
 */

export const SETTINGS_BASE_NAME = 'IdentityBase';
export const SETTINGS_TABLE_NAME = 'auth_tbl_Settings';

/** Values and IDs are trusted for this long before NocoDB is asked again. */
export const CACHE_TTL_MS = 30_000;

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

interface NocoRow {
  Key: string;
  Value: string | null;
}

interface ResolvedIds {
  baseId: string;
  tableId: string;
}

export interface SettingsStoreConfig {
  NOCODB_BASE_URL: string;
  NOCODB_API_TOKEN: string;
}

export class SettingsStore {
  private ids: { at: number; ids: ResolvedIds } | null = null;
  private cache: { at: number; settings: Settings } | null = null;

  constructor(
    private config: SettingsStoreConfig,
    private overrides: Settings = {}
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

  /** The base and table IDs, found by name. Cached, and dropped on failure. */
  private async resolveIds(): Promise<ResolvedIds> {
    if (this.ids && Date.now() - this.ids.at < CACHE_TTL_MS) return this.ids.ids;
    if (!this.config.NOCODB_BASE_URL || !this.config.NOCODB_API_TOKEN) {
      throw new SettingsUnavailableError(
        'unconfigured',
        'NOCODB_BASE_URL and NOCODB_API_TOKEN must both be set — they are the only ' +
          'two things this app reads from its environment.'
      );
    }
    try {
      const bases = await this.api<{ list: Array<{ id: string; title: string }> }>(
        '/api/v2/meta/bases'
      );
      const matches = bases.list.filter((b) => b.title === SETTINGS_BASE_NAME);
      if (matches.length === 0) {
        throw new SettingsUnavailableError(
          'base_missing',
          `No NocoDB base named ${SETTINGS_BASE_NAME} at ${this.config.NOCODB_BASE_URL}. ` +
            'The base is found by name, so a renamed base looks like a missing one.'
        );
      }
      if (matches.length > 1) {
        throw new SettingsUnavailableError(
          'base_ambiguous',
          `${matches.length} NocoDB bases are named ${SETTINGS_BASE_NAME}. The name must ` +
            'be unique — this app will not guess which one holds its settings.'
        );
      }
      const baseId = matches[0].id;
      const tables = await this.api<{ list: Array<{ id: string; title: string }> }>(
        `/api/v2/meta/bases/${baseId}/tables`
      );
      const table = tables.list.find((t) => t.title === SETTINGS_TABLE_NAME);
      if (!table) {
        throw new SettingsUnavailableError(
          'table_missing',
          `The base ${SETTINGS_BASE_NAME} has no table named ${SETTINGS_TABLE_NAME}.`
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

  /** Every row, with the environment overriding the store. */
  async getAll(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.settings;
    const { tableId } = await this.resolveIds();
    try {
      const settings: Settings = {};
      let offset = 0;
      for (;;) {
        const page = await this.api<{ list: NocoRow[]; pageInfo?: { isLastPage?: boolean } }>(
          `/api/v2/tables/${tableId}/records?limit=200&offset=${offset}`
        );
        for (const row of page.list) {
          if (row.Key && row.Value != null && String(row.Value).trim() !== '') {
            settings[row.Key] = String(row.Value).trim();
          }
        }
        if (page.list.length < 200 || page.pageInfo?.isLastPage !== false) break;
        offset += 200;
      }
      Object.assign(settings, this.overrides);
      this.cache = { at: Date.now(), settings };
      return settings;
    } catch (err) {
      this.ids = null; // the table ID may have gone stale with the base
      throw this.asUnavailable(err);
    }
  }

  /** Force the next read to re-detect the base as well as re-read the rows. */
  invalidate(): void {
    this.cache = null;
    this.ids = null;
  }
}
