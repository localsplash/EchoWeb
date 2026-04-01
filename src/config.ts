import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  BANDWIDTH_ACCOUNT_ID: z.string().min(1),
  BANDWIDTH_API_TOKEN: z.string().min(1),
  BANDWIDTH_API_SECRET: z.string().min(1),
  BANDWIDTH_APPLICATION_ID: z.string().uuid(),
  BANDWIDTH_MESSAGING_API_BASE_URL: z.string().url().default('https://messaging.bandwidth.com/api/v2'),
  INBOUND_STORAGE_DIR: z.string().default('./inbound'),
  ECHO_SERVICE_BASE_URL: z.string().url().default('https://io.echo.wisp.net'),
  LOG_LEVEL: z.string().default('info'),
  DB_HOST: z.string().default('echo-database'),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default('echo_app'),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().default('echo_db')
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  return envSchema.parse(process.env);
}
