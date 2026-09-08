import { z } from 'zod';
import {
  CACHE_TTL_MS,
  PlatformSettingsStore,
  Settings,
  SettingsUnavailableError,
} from './settings';

/** Runtime config: PlatformConfig scopes echo-web -> echo -> *, overridden
 * by nonblank environment settings. DB coordinates remain process bootstrap;
 * pools require restart to change. No SQL/IdentityBase settings readers remain. */
const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3160),
  LOG_LEVEL: z.string().default('info'),

  // Echo application database pool coordinates remain deployment bootstrap.
  // Runtime settings use the selected PlatformConfig/legacy reader below.
  DB_HOST: z.string().default(''),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default(''),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default(''),

  // Service-owned NocoDB bootstrap, provided directly by the deployment.
  NOCODB_BASE_URL: z.string().default(''),
  NOCODB_API_TOKEN: z.string().default(''),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return envSchema.parse(env);
}

/** Runtime setting keys, with explicit environment overrides. */
export const SETTING_KEYS = [
  'PARENT_DOMAIN',
  'IDENTITY_BASE_URL',
  'IDENTITY_PUBLIC_BASE_URL',
  'IDENTITY_CLIENT_SECRET',
  'ECHO_SERVICE_BASE_URL',
  'MEDIA_BASE_URL',
  'MEDIA_INTERNAL_BASE_URL',
  'APP_BASE_URL',
  'UISP_PLUGIN_URL',
  // Only the two public halves — the app id and the secret belong to
  // EchoService, which publishes and signs channel authorizations. Both blank
  // is supported: the browser falls back to the 30-second poll.
  'PUSHER_KEY',
  'PUSHER_CLUSTER',
] as const;

export interface AppConfig extends EnvConfig {
  ECHO_SERVICE_BASE_URL: string;
  MEDIA_BASE_URL: string;
  /** Private EchoMedia origin. When set, browsers use the authenticated proxy. */
  MEDIA_INTERNAL_BASE_URL?: string;
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

/**
 * Any settings key may be pinned in the environment, where it wins over the
 * row — an override for deployments that manage configuration as
 * environment, not a default. Blank counts as unset.
 */
function overridesFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const overrides: Settings = {};
  for (const key of SETTING_KEYS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '')
      overrides[key] = raw.trim();
  }
  return overrides;
}

let platformStore: PlatformSettingsStore | null = null;
let snapshot: { at: number; config: AppConfig } | null = null;

/** `https://<label>.<parent>`, or '' when the platform domain is unknown. */
function hostUnder(parent: string, label: string): string {
  return parent ? `https://${label}.${parent}` : '';
}

function assemble(
  env: EnvConfig,
  settings: Settings,
  identity: Settings,
): AppConfig {
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
    MEDIA_INTERNAL_BASE_URL: value('MEDIA_INTERNAL_BASE_URL'),
    APP_BASE_URL: derived('APP_BASE_URL', 'echo'),
    UISP_PLUGIN_URL: value('UISP_PLUGIN_URL'),
    PUSHER_KEY: value('PUSHER_KEY'),
    PUSHER_CLUSTER: value('PUSHER_CLUSTER'),
    PARENT_DOMAIN: parent,
    IDENTITY_CLIENT_SECRET: identity.IDENTITY_CLIENT_SECRET ?? '',
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
  const identity = await platformStore.get();
  const settings = {
    ...identity,
    ...overridesFromEnv(),
  };
  const config = assemble(env, settings, settings);
  for (const key of [
    'PARENT_DOMAIN',
    'ECHO_SERVICE_BASE_URL',
    'APP_BASE_URL',
    'IDENTITY_BASE_URL',
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
