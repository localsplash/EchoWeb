import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  ECHO_SERVICE_BASE_URL: z.string().url().default('https://io.echo.wisp.net'),
  LOG_LEVEL: z.string().default('info')
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  return envSchema.parse(process.env);
}
