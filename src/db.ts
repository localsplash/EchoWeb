import mysql from 'mysql2/promise';
import { EnvConfig } from './config';

let pool: mysql.Pool | null = null;

/**
 * The Echo database.
 *
 * Its coordinates come from the environment rather than from the settings,
 * because this is where the settings themselves live — a database cannot
 * carry its own address. Everything else about this app is a row in
 * echo_tbl_Settings.
 */
export function getDb(config: EnvConfig): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      timezone: 'Z',
    });
  }
  return pool;
}
