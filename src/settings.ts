/** Values are trusted for this long before the source is asked again. */
export const CACHE_TTL_MS = 30_000;

export type Settings = Record<string, string>;

export class SettingsUnavailableError extends Error {
  constructor(
    public reason: 'unconfigured' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'SettingsUnavailableError';
  }
}

interface NocoConfig {
  NOCODB_BASE_URL: string;
  NOCODB_API_TOKEN: string;
}

export class PlatformSettingsStore {
  private ids: { at: number; tableId: string } | null = null;
  private cache: { at: number; values: Settings } | null = null;

  constructor(private config: NocoConfig) {}

  private async api<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.config.NOCODB_BASE_URL}${path}`, {
      headers: {
        'xc-token': this.config.NOCODB_API_TOKEN,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!resp.ok) {
      throw new Error(`NocoDB GET ${path} failed: ${resp.status}`);
    }
    return resp.json() as Promise<T>;
  }

  private async resolveTable(): Promise<string> {
    if (this.ids && Date.now() - this.ids.at < CACHE_TTL_MS)
      return this.ids.tableId;
    if (!this.config.NOCODB_BASE_URL || !this.config.NOCODB_API_TOKEN) {
      throw new SettingsUnavailableError(
        'unconfigured',
        'NOCODB_BASE_URL and NOCODB_API_TOKEN must be provided for PlatformConfig.',
      );
    }
    // Found by NAME at runtime, never by an ID from a config file: an ID
    // survives a rename and outlives a restore.
    const bases = await this.api<{
      list: Array<{ id: string; title: string }>;
    }>('/api/v2/meta/bases');
    const baseName = 'PlatformConfig';
    const tableName = 'cfg_tbl_Setting';
    const matches = bases.list.filter((b) => b.title === baseName);
    if (matches.length !== 1) {
      throw new SettingsUnavailableError(
        'unreachable',
        `Expected exactly one NocoDB base named ${baseName}, found ${matches.length}.`,
      );
    }
    const tables = await this.api<{
      list: Array<{ id: string; title: string }>;
    }>(`/api/v2/meta/bases/${matches[0].id}/tables`);
    const matchingTables = tables.list.filter((t) => t.title === tableName);
    const table = matchingTables[0];
    if (matchingTables.length !== 1) {
      throw new SettingsUnavailableError(
        'unreachable',
        `Expected one ${tableName} table in ${baseName}, found ${matchingTables.length}.`,
      );
    }
    this.ids = { at: Date.now(), tableId: table.id };
    return table.id;
  }

  async get(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS)
      return this.cache.values;
    try {
      const tableId = await this.resolveTable();
      const rows: Array<{
        app?: string;
        settingKey?: string;
        settingValue?: string | null;
      }> = [];
      for (let offset = 0; ; offset += 200) {
        const page = await this.api<{
          list: typeof rows;
          pageInfo?: { isLastPage?: boolean };
        }>(`/api/v2/tables/${tableId}/records?limit=200&offset=${offset}`);
        rows.push(...page.list);
        if (page.list.length < 200 || page.pageInfo?.isLastPage === true) break;
      }
      const values: Settings = {};
      const seen = new Set<string>();
      for (const row of rows) {
        const key = JSON.stringify([row.app, row.settingKey]);
        if (seen.has(key))
          throw new SettingsUnavailableError(
            'unreachable',
            'Duplicate scoped configuration key',
          );
        seen.add(key);
      }
      for (const scope of ['*', 'echo', 'echo-web'])
        for (const row of rows.filter((r) => r.app === scope)) {
          if (row.settingKey && row.settingValue?.trim())
            values[row.settingKey] = row.settingValue.trim();
        }
      this.cache = { at: Date.now(), values };
      return values;
    } catch (err) {
      // Never reuse an ID we could not confirm.
      this.ids = null;
      this.cache = null;
      if (err instanceof SettingsUnavailableError) throw err;
      throw new SettingsUnavailableError(
        'unreachable',
        `NocoDB at ${this.config.NOCODB_BASE_URL} did not answer or rejected the token: ` +
          String(err instanceof Error ? err.message : err).slice(0, 200),
      );
    }
  }

  invalidate(): void {
    this.cache = null;
    this.ids = null;
  }
}
