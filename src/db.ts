import mysql from 'mysql2/promise';
import { loadConfig, type AppConfig } from './config';

export class DatabaseNotConfiguredError extends Error {}

export function dbCoordinates(config: AppConfig) {
  if (!config.DB_HOST || !config.DB_USER || !config.DB_NAME) {
    throw new DatabaseNotConfiguredError(
      'Configure DB_HOST (or PARENT_DOMAIN), DB_USER and DB_NAME in PlatformConfig for echo-web',
    );
  }
  if (!Number.isInteger(config.DB_PORT) || config.DB_PORT < 1 || config.DB_PORT > 65535) {
    throw new DatabaseNotConfiguredError('DB_PORT must be an integer from 1 to 65535 in PlatformConfig');
  }
  return { host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER,
    password: config.DB_PASSWORD, database: config.DB_NAME };
}

let pool: mysql.Pool | null = null;

/** Resolve PlatformConfig on first database use. Once created, restart to repoint the pool. */
export function getDb(): mysql.Pool {
  const real = () => {
    if (!pool) pool = mysql.createPool({
      ...dbCoordinates(loadConfig()), waitForConnections: true, connectionLimit: 5,
      timezone: 'Z', supportBigNumbers: true, bigNumberStrings: false,
    });
    return pool;
  };
  return {
    async query(...args: unknown[]) {
      const p = real();
      return (p.query as (...a: unknown[]) => unknown)(...args);
    },
    async getConnection() { return real().getConnection(); },
    async end() { if (pool) await pool.end(); pool = null; },
  } as unknown as mysql.Pool;
}
