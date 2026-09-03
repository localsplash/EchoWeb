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
