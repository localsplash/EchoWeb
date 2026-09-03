import { z } from 'zod';
import mysql from 'mysql2/promise';
import {
  CACHE_TTL_MS,
  Settings,
  SettingsUnavailableError,
  readEchoSettings,
} from './settings';

/**
 * Configuration comes from the Echo database, not from `.env`.
 *
 * The environment states the one thing that cannot describe itself: the Echo
 * database, because you cannot read a database's address out of that
 * database. Everything else is a row in `echo_tbl_Settings` — see EchoDatabase
 * `init/009_settings.sql`.
 *
 * That is the whole of it. This app reads nothing from NocoDB, so a
 * deployment needs no NocoDB credentials to run it (#17).
 *
 * Nothing below carries a default. An invented `https://io.echo.wisp.net` or
 * `echo-database` is a value that looks configured and is wrong, which is
 * worse than one that is plainly missing.
 *
 * `loadConfig()` stays synchronous and keeps the shape every caller already
 * expects. What changed is where the object comes from: a snapshot refreshed
 * at most every 30 seconds by the middleware in app.ts, so a settings change
 * reaches this app without a restart. Reading before the first successful
 * refresh throws rather than guessing.
 */

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),

  // The Echo database. Its coordinates are the one thing that has to be
  // stated outside it — everything else about this app lives in
  // echo_tbl_Settings.
  DB_HOST: z.string().default(''),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default(''),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default(''),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return envSchema.parse(env);
}

/** The keys this app reads out of `echo_tbl_Settings`. */
export const SETTING_KEYS = [
  'ECHO_SERVICE_BASE_URL',
  'MEDIA_BASE_URL',
  'APP_BASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT',
  'UISP_BASE_URL',
  'UISP_CRM_APP_KEY_READ',
  'UISP_SSO_SECRET',
  'UISP_PLUGIN_URL',
  // Real-time updates (#16). Only the two public halves — the app id and the
  // secret belong to EchoService, which is what publishes and what signs
  // channel authorizations. Both blank is a supported deployment: the browser
  // falls back to the 30-second poll (#15).
  'PUSHER_KEY',
  'PUSHER_CLUSTER',
] as const;

export interface AppConfig extends EnvConfig {
  ECHO_SERVICE_BASE_URL: string;
  MEDIA_BASE_URL: string;
  APP_BASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_TENANT: string;
  UISP_BASE_URL: string;
  UISP_CRM_APP_KEY_READ: string;
  UISP_SSO_SECRET: string;
  UISP_PLUGIN_URL: string;
  PUSHER_KEY: string;
  PUSHER_CLUSTER: string;
}

/**
 * Any settings key may be pinned in the environment, where it wins over the
 * row — an override for deployments that manage configuration as
 * environment, not a default. Blank counts as unset.
 */
function overridesFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const overrides: Settings = {};
  for (const key of SETTING_KEYS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '') overrides[key] = raw.trim();
  }
  return overrides;
}

let snapshot: { at: number; config: AppConfig } | null = null;

function assemble(env: EnvConfig, settings: Settings): AppConfig {
  const value = (key: string): string => settings[key] ?? '';
  return {
    ...env,
    ECHO_SERVICE_BASE_URL: value('ECHO_SERVICE_BASE_URL'),
    MEDIA_BASE_URL: value('MEDIA_BASE_URL'),
    APP_BASE_URL: value('APP_BASE_URL'),
    GOOGLE_CLIENT_ID: value('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: value('GOOGLE_CLIENT_SECRET'),
    MICROSOFT_CLIENT_ID: value('MICROSOFT_CLIENT_ID'),
    MICROSOFT_CLIENT_SECRET: value('MICROSOFT_CLIENT_SECRET'),
    MICROSOFT_TENANT: value('MICROSOFT_TENANT'),
    UISP_BASE_URL: value('UISP_BASE_URL'),
    UISP_CRM_APP_KEY_READ: value('UISP_CRM_APP_KEY_READ'),
    UISP_SSO_SECRET: value('UISP_SSO_SECRET'),
    UISP_PLUGIN_URL: value('UISP_PLUGIN_URL'),
    PUSHER_KEY: value('PUSHER_KEY'),
    PUSHER_CLUSTER: value('PUSHER_CLUSTER'),
  };
}

/** Read the settings and replace the snapshot. Throws if they cannot be read. */
export async function refreshConfig(db: mysql.Pool): Promise<AppConfig> {
  const env = loadEnv();
  const settings = { ...(await readEchoSettings(db)), ...overridesFromEnv() };
  const config = assemble(env, settings);
  snapshot = { at: Date.now(), config };
  return config;
}

/** Refresh only when the snapshot has aged out; used per request. */
export async function ensureFreshConfig(db: mysql.Pool): Promise<AppConfig> {
  if (snapshot && Date.now() - snapshot.at < CACHE_TTL_MS) return snapshot.config;
  return refreshConfig(db);
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
      'Settings have not been read yet — echo_tbl_Settings was unreachable at startup.'
    );
  }
  return snapshot.config;
}

/** Drop the snapshot; the retry path. */
export function invalidateConfig(): void {
  snapshot = null;
}

/** Test seam: install a snapshot without touching the database. */
export function setConfigForTesting(config: AppConfig): void {
  snapshot = { at: Date.now(), config };
}
