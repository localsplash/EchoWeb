import { z } from 'zod';
import {
  CACHE_TTL_MS,
  PlatformSettingsStore,
  Settings,
  SettingsUnavailableError,
} from './settings';

/** Runtime config: PlatformConfig scopes echo-web -> echo -> * are the only
 * source for application settings, including DB coordinates;
 * pools require restart to change. No SQL/IdentityBase settings readers remain. */
const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3160),
  LOG_LEVEL: z.string().default('info'),

  // Service-owned NocoDB bootstrap, provided directly by the deployment.
  NOCODB_BASE_URL: z.string().default(''),
  NOCODB_API_TOKEN: z.string().default(''),

  // Container topology: which address on the internal network answers for a
  // sibling service. Compose assigns these names, so compose is where they
  // belong — not a settings row that can drift from the file that defines
  // them. The defaults are the standard stack; override only where the
  // service names differ, as in a preview environment.
  ECHO_SERVICE_BASE_URL: z.string().default('http://echo-service-private:8080'),
  MEDIA_INTERNAL_BASE_URL: z.string().default('http://echo-media:8082'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return envSchema.parse(env);
}

/** Runtime setting keys, read only from cfg_tbl_Setting. A same-named
 * environment variable is ignored: two homes for one value meant a row could be
 * edited with no effect and nothing on the host to say why. */
export const SETTING_KEYS = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'PARENT_DOMAIN',
  'IDENTITY_BASE_URL',
  'IDENTITY_PUBLIC_BASE_URL',
  'IDENTITY_CLIENT_SECRET',
  'APP_BASE_URL',
  'UISP_PLUGIN_URL',
  // Only the two public halves — the app id and the secret belong to
  // EchoService, which publishes and signs channel authorizations. Both blank
  // is supported: the browser falls back to the 30-second poll.
  'PUSHER_KEY',
  'PUSHER_CLUSTER',
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

export interface AppConfig extends EnvConfig {
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  APP_BASE_URL: string;
  UISP_PLUGIN_URL: string;
  PUSHER_KEY: string;
  PUSHER_CLUSTER: string;
  /** Shared platform domain from the selected settings source. */
  PARENT_DOMAIN: string;
  IDENTITY_CLIENT_SECRET: string;
  /** Derived from PARENT_DOMAIN unless a row pins it. */
  IDENTITY_BASE_URL: string;
  /** Browser sign-in origin; defaults to the server API origin. */
  IDENTITY_PUBLIC_BASE_URL?: string;
}

let platformStore: PlatformSettingsStore | null = null;
let snapshot: { at: number; config: AppConfig } | null = null;

/** `https://<label>.<parent>`, or '' when the platform domain is unknown. */
function hostUnder(parent: string, label: string): string {
  return parent ? `https://${label}.${parent}` : '';
}

function assemble(env: EnvConfig, settings: Settings): AppConfig {
  const value = (key: SettingKey): string => settings[key] ?? '';
  const parent = value('PARENT_DOMAIN');
  // A row wins over the derived value; blank means derive. The naming scheme
  // is the platform's, so it lives here rather than in twelve rows.
  const derived = (key: SettingKey, label: string): string =>
    value(key) || hostUnder(parent, label);
  return {
    ...env,
    DB_HOST: value('DB_HOST') || (parent ? `lsdb.${parent}` : ''),
    DB_PORT: Number(value('DB_PORT') || 3306),
    DB_USER: value('DB_USER'),
    DB_PASSWORD: value('DB_PASSWORD'),
    DB_NAME: value('DB_NAME'),
    APP_BASE_URL: derived('APP_BASE_URL', 'echo'),
    UISP_PLUGIN_URL: value('UISP_PLUGIN_URL'),
    PUSHER_KEY: value('PUSHER_KEY'),
    PUSHER_CLUSTER: value('PUSHER_CLUSTER'),
    PARENT_DOMAIN: parent,
    IDENTITY_CLIENT_SECRET: value('IDENTITY_CLIENT_SECRET'),
    IDENTITY_BASE_URL:
      value('IDENTITY_BASE_URL') || hostUnder(parent, 'identity'),
    IDENTITY_PUBLIC_BASE_URL:
      value('IDENTITY_PUBLIC_BASE_URL') ||
      value('IDENTITY_BASE_URL') ||
      hostUnder(parent, 'identity'),
  };
}

/** Read the settings and replace the snapshot. Throws if they cannot be read. */
export async function refreshConfig(): Promise<AppConfig> {
  const env = loadEnv();
  if (!platformStore) platformStore = new PlatformSettingsStore(env);
  const settings = await platformStore.get();
  const config = assemble(env, settings);
  for (const key of [
    'PARENT_DOMAIN',
    'ECHO_SERVICE_BASE_URL',
    'APP_BASE_URL',
    'IDENTITY_BASE_URL',
    'MEDIA_INTERNAL_BASE_URL',
  ] as const) {
    if (!config[key])
      throw new SettingsUnavailableError(
        'unconfigured',
        `${key} is required`,
      );
  }
  for (const key of [
    'ECHO_SERVICE_BASE_URL',
    'APP_BASE_URL',
    'IDENTITY_BASE_URL',
    'IDENTITY_PUBLIC_BASE_URL',
    'MEDIA_INTERNAL_BASE_URL',
  ] as const) {
    if (!config[key]) continue;
    try {
      const url = new URL(config[key]!);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('invalid');
    } catch {
      throw new SettingsUnavailableError(
        'unconfigured',
        `${key} must be an HTTP(S) URL without embedded credentials`,
      );
    }
  }
  snapshot = { at: Date.now(), config };
  return config;
}

/** Refresh only when the snapshot has aged out; used per request. */
export async function ensureFreshConfig(): Promise<AppConfig> {
  if (snapshot && Date.now() - snapshot.at < CACHE_TTL_MS)
    return snapshot.config;
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
      'Application settings have not been read yet.',
    );
  }
  return snapshot.config;
}

/** Drop the snapshot; the retry path. */
export function invalidateConfig(): void {
  snapshot = null;
  platformStore?.invalidate();
}

/** Test seam: install a snapshot without touching the database. */
export function setConfigForTesting(config: AppConfig): void {
  snapshot = { at: Date.now(), config };
}
