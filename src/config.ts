import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  ECHO_SERVICE_BASE_URL: z.string().url().default('https://io.echo.wisp.net'),
  MEDIA_BASE_URL: z.string().default('https://media.echo.wisp.net'),
  LOG_LEVEL: z.string().default('info'),

  // Database (EchoWeb accesses the DB directly for auth)
  DB_HOST: z.string().default('echo-database'),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default('echo_app'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('echo_db'),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  // Microsoft (Entra ID) OAuth. The login page hides the button until the
  // client id is set, so an unconfigured deployment simply doesn't offer it.
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  // Authority segment. 'common' accepts any work/school account plus personal
  // Microsoft accounts — the parallel to Google accepting any Google account.
  // A directory (tenant) GUID here would restrict sign-in to that tenant alone.
  MICROSOFT_TENANT: z.string().default('common'),
  // Wisp's own directory. Super-admin is granted on an @wisp.net address, and
  // Entra's `email` claim is tenant-controlled — so with MICROSOFT_TENANT set to
  // 'common', any tenant on earth could mint one. Microsoft sign-ins therefore
  // only reach the super-admin branch when the token came from this directory.
  MICROSOFT_WISP_TENANT_ID: z.string().default('ae0d317b-49e2-46b9-84e7-964f8b1dedbb'),

  // UISP integration
  UISP_BASE_URL: z.string().url().default('https://my.wisp.net'),
  UISP_CRM_APP_KEY_READ: z.string().default(''),
  UISP_SSO_SECRET: z.string().default(''),
  // UCRM generates the plugin's public URL on install and shows it on the
  // plugin page. Copy it here; the login page hides the ISP button until it's set.
  UISP_PLUGIN_URL: z.string().default(''),

  // Public app URL (used for OAuth callback URI)
  APP_BASE_URL: z.string().url().default('https://dev-echo.localsplash.ai'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  return envSchema.parse(process.env);
}
