import mysql from 'mysql2/promise';
import { AppConfig } from './config';

let pool: mysql.Pool | null = null;

export function getDb(config: AppConfig): mysql.Pool {
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
