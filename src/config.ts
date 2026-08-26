import { z } from 'zod';

/**
 * Environment carries only infrastructure plumbing. OAuth is delegated to
 * the `id` app; the settings shared across the domain's applications —
 * where id lives, the code-exchange secret, UISP CRM access — come from the
 * NocoDB `oAuthConfig` table (see idClient.ts), not from here.
 */
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

  // NocoDB settings store (shared oAuthConfig table)
  NOCODB_BASE_URL: z.string().url().default('http://nocodb:8080'),
  NOCODB_API_TOKEN: z.string().default(''),
  NOCODB_BASE_NAME: z.string().default('id'),
  NOCODB_TABLE_NAME: z.string().default('oAuthConfig'),

  // This app's own public URL (used to build the redirect_uri handed to id)
  APP_BASE_URL: z.string().url().default('https://dev-echo.localsplash.ai'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  return envSchema.parse(process.env);
}
