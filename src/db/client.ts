import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import type { AppConfig } from '../config';

export function createDb(config: AppConfig) {
  const pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z'
  });

  const db = drizzle({ client: pool });

  return { db, pool };
}
