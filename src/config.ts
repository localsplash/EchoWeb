import { z } from 'zod';
import { SettingsStore, Settings, SettingsUnavailableError, CACHE_TTL_MS } from './settings';

/**
 * Configuration comes from the settings table, not from `.env`.
 *
 * The environment states two things — where the settings live and the token
 * to read them with — and everything else is a row in `auth_tbl_Settings`
 * inside the `IdentityBase` base (see localsplash/identity#15). That is why
 * nothing below carries a default: an invented `https://io.echo.wisp.net` or
 * `echo-database` is a value that looks configured and is wrong, which is
 * worse than one that is plainly missing.
 *
 * `loadConfig()` stays synchronous and keeps the shape every caller already
 * expects. What changed is where the object comes from: a snapshot of the
 * settings, refreshed at most every 30 seconds by the middleware in app.ts,
 * so a change in NocoDB reaches this app without a restart. Reading before
 * the first successful refresh throws rather than guessing.
 */

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),

  // The only two things this app reads from its environment.
  NOCODB_BASE_URL: z.string().default(''),
  NOCODB_API_TOKEN: z.string().default(''),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return envSchema.parse(env);
}

/** The keys this app reads out of `auth_tbl_Settings`. */
export const SETTING_KEYS = [
  'ECHO_SERVICE_BASE_URL',
  'MEDIA_BASE_URL',
  'APP_BASE_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT',
  'UISP_BASE_URL',
  'UISP_CRM_APP_KEY_READ',
  'UISP_SSO_SECRET',
  'UISP_PLUGIN_URL',
  // One value for the whole platform, not a per-app spelling of the same
  // network: the servers inside it are the first-party ones.
  'trustedCIDR',
] as const;

export interface AppConfig extends EnvConfig {
  ECHO_SERVICE_BASE_URL: string;
  MEDIA_BASE_URL: string;
  APP_BASE_URL: string;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_TENANT: string;
  UISP_BASE_URL: string;
  UISP_CRM_APP_KEY_READ: string;
  UISP_SSO_SECRET: string;
  UISP_PLUGIN_URL: string;
  trustedCIDR: string;
}

/**
 * Any key may be pinned in the environment, where it wins over the store —
 * an override for deployments that manage configuration as environment, not
 * a default. Blank counts as unset.
 */
function overridesFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const overrides: Settings = {};
  const take = (key: string, from: string): void => {
    if (key in overrides) return;
    const raw = env[from];
    if (typeof raw === 'string' && raw.trim() !== '') overrides[key] = raw.trim();
  };
  for (const key of SETTING_KEYS) take(key, key);
  // `trustedCIDR` reads oddly as a variable name.
  take('trustedCIDR', 'IDENTITY_TRUSTED_NETWORK');
  return overrides;
}

let store: SettingsStore | null = null;
let snapshot: { at: number; config: AppConfig } | null = null;

function settingsStore(): SettingsStore {
  if (!store) store = new SettingsStore(loadEnv(), overridesFromEnv());
  return store;
}

function assemble(env: EnvConfig, settings: Settings): AppConfig {
  const port = Number.parseInt((settings.DB_PORT ?? '').trim(), 10);
  return {
    ...env,
    ECHO_SERVICE_BASE_URL: settings.ECHO_SERVICE_BASE_URL ?? '',
    MEDIA_BASE_URL: settings.MEDIA_BASE_URL ?? '',
    APP_BASE_URL: settings.APP_BASE_URL ?? '',
    DB_HOST: settings.DB_HOST ?? '',
    // MySQL's own registered port — the protocol's default, not a guess
    // about this deployment.
    DB_PORT: Number.isFinite(port) && port > 0 ? port : 3306,
    DB_USER: settings.DB_USER ?? '',
    DB_PASSWORD: settings.DB_PASSWORD ?? '',
    DB_NAME: settings.DB_NAME ?? '',
    GOOGLE_CLIENT_ID: settings.GOOGLE_CLIENT_ID ?? '',
    GOOGLE_CLIENT_SECRET: settings.GOOGLE_CLIENT_SECRET ?? '',
    MICROSOFT_CLIENT_ID: settings.MICROSOFT_CLIENT_ID ?? '',
    MICROSOFT_CLIENT_SECRET: settings.MICROSOFT_CLIENT_SECRET ?? '',
    MICROSOFT_TENANT: settings.MICROSOFT_TENANT ?? '',
    UISP_BASE_URL: settings.UISP_BASE_URL ?? '',
    UISP_CRM_APP_KEY_READ: settings.UISP_CRM_APP_KEY_READ ?? '',
    UISP_SSO_SECRET: settings.UISP_SSO_SECRET ?? '',
    UISP_PLUGIN_URL: settings.UISP_PLUGIN_URL ?? '',
    trustedCIDR: settings.trustedCIDR ?? '',
  };
}

/** Read the settings and replace the snapshot. Throws if they cannot be read. */
export async function refreshConfig(): Promise<AppConfig> {
  const config = assemble(loadEnv(), await settingsStore().getAll());
  snapshot = { at: Date.now(), config };
  return config;
}

/** Refresh only when the snapshot has aged out; used per request. */
export async function ensureFreshConfig(): Promise<AppConfig> {
  if (snapshot && Date.now() - snapshot.at < CACHE_TTL_MS) return snapshot.config;
  return refreshConfig();
}

/**
 * The current settings, synchronously. Throws when nothing has been read
 * yet — an app that cannot read its configuration says so rather than
 * carrying on with blanks.
 */
export function loadConfig(): AppConfig {
  if (!snapshot) {
    throw new SettingsUnavailableError(
      'unreachable',
      'Settings have not been read yet — the settings store was unreachable at startup.'
    );
  }
  return snapshot.config;
}

/** Drop the snapshot and the resolved base/table IDs; the retry path. */
export function invalidateConfig(): void {
  snapshot = null;
  settingsStore().invalidate();
}

/** Test seam: install a snapshot without touching NocoDB. */
export function setConfigForTesting(config: AppConfig): void {
  snapshot = { at: Date.now(), config };
}
