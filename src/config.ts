import { z } from 'zod';
import mysql from 'mysql2/promise';
import {
  CACHE_TTL_MS,
  IdentitySettingsStore,
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
 * Two values come from IdentityBase instead, because the platform decides
 * them once for everybody: PARENT_DOMAIN and IDENTITY_CLIENT_SECRET. See
 * settings.ts.
 *
 * Every public URL follows from PARENT_DOMAIN. Echo's apps are named
 * `<app>-echo.<parent>`, and the web app — the one people type — is plain
 * `echo.<parent>`:
 *
 *     APP_BASE_URL       https://echo.<parent>
 *     MEDIA_BASE_URL     https://media-echo.<parent>
 *     IDENTITY_BASE_URL  https://identity.<parent>
 *
 * so moving the platform to a new domain is one edit rather than a hunt
 * through rows. A row in echo_tbl_Settings still overrides any of them, for
 * the deployment that genuinely differs; blank means "derive it".
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

  // Where to read PARENT_DOMAIN and IDENTITY_CLIENT_SECRET from. On a
  // single-host install these arrive in identity's own bootstrap file,
  // mounted read-only at /data — nothing to stated here.
  NOCODB_BASE_URL: z.string().default(''),
  NOCODB_API_TOKEN: z.string().default(''),
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
  /** From IdentityBase — the platform's, not this app's. */
  PARENT_DOMAIN: string;
  IDENTITY_CLIENT_SECRET: string;
  /** Derived from PARENT_DOMAIN unless a row pins it. */
  IDENTITY_BASE_URL: string;
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

let identityStore: IdentitySettingsStore | null = null;
let snapshot: { at: number; config: AppConfig } | null = null;

/** `https://<label>.<parent>`, or '' when the platform domain is unknown. */
function hostUnder(parent: string, label: string): string {
  return parent ? `https://${label}.${parent}` : '';
}

function assemble(env: EnvConfig, settings: Settings, identity: Settings): AppConfig {
  const value = (key: string): string => settings[key] ?? '';
  const parent = identity.PARENT_DOMAIN ?? '';
  // A row wins over the derived value; blank means derive. The naming scheme
  // is the platform's, so it lives here rather than in twelve rows.
  const derived = (key: string, label: string): string =>
    value(key) || hostUnder(parent, label);
  return {
    ...env,
    // Internal, container-to-container: not a public hostname and not derived.
    ECHO_SERVICE_BASE_URL: value('ECHO_SERVICE_BASE_URL'),
    MEDIA_BASE_URL: derived('MEDIA_BASE_URL', 'media-echo'),
    APP_BASE_URL: derived('APP_BASE_URL', 'echo'),
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
    PARENT_DOMAIN: parent,
    IDENTITY_CLIENT_SECRET: identity.IDENTITY_CLIENT_SECRET ?? '',
    IDENTITY_BASE_URL: value('IDENTITY_BASE_URL') || hostUnder(parent, 'identity'),
  };
}

/** Read the settings and replace the snapshot. Throws if they cannot be read. */
export async function refreshConfig(db: mysql.Pool): Promise<AppConfig> {
  const env = loadEnv();
  if (!identityStore) identityStore = new IdentitySettingsStore(env);
  const [settings, identity] = await Promise.all([
    readEchoSettings(db).then((rows) => ({ ...rows, ...overridesFromEnv() })),
    identityStore.get(),
  ]);
  const config = assemble(env, settings, identity);
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
  identityStore?.invalidate();
}

/** Test seam: install a snapshot without touching the database. */
export function setConfigForTesting(config: AppConfig): void {
  snapshot = { at: Date.now(), config };
}
