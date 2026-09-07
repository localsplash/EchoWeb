import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { availableBusinesses, type PlatformIdentity } from './platformSession';
const run = promisify(execFile),
  url = process.env.TEST_DB_URL,
  source = process.env.ECHO_DATABASE_SOURCE;
describe.skipIf(!url)('Echo mapping migration and cutover (real MySQL)', () => {
  let pool: mysql.Pool, dbUrl: string, temp: string;
  const orgs = [
    { iOrgId: 1, iTenantId: 11, iBusinessNumber: 7145550001 },
    { iOrgId: 2, iTenantId: 22, iBusinessNumber: 7145550002 },
  ];
  const identity = (tenantIds: number[]): PlatformIdentity => ({
    active: true,
    user: { iUserId: 91, email: null, displayName: null, superAdmin: false },
    selectedTenantId: tenantIds[0] ?? null,
    tenants: tenantIds.map((iTenantId) => ({
      iTenantId,
      name: `Office ${iTenantId}`,
      slug: `office-${iTenantId}`,
      role: 'USER',
      bEnabled: true,
    })),
  });
  beforeAll(async () => {
    if (!source)
      throw new Error(
        'Set ECHO_DATABASE_SOURCE to the reviewed EchoDatabase checkout mounted beneath /app',
      );
    const parsed = new URL(url!);
    parsed.pathname = '/echo_platform_test';
    dbUrl = parsed.toString();
    const admin = await mysql.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
    await admin.query('DROP DATABASE IF EXISTS echo_platform_test');
    await admin.query('CREATE DATABASE echo_platform_test');
    await admin.end();
    pool = mysql.createPool({
      uri: dbUrl,
      multipleStatements: true,
      timezone: 'Z',
    });
    const sql = (name: string) =>
      fs
        .readFileSync(path.join(source, 'init', name), 'utf8')
        .replace('USE echo_db;', '');
    await pool.query(sql('005_auth.sql'));
    await pool.query(`INSERT INTO auth_tbl_Org (iOrgId,iBusinessNumber,displayName) VALUES (1,7145550001,'First'),(2,7145550002,'Second');
    INSERT INTO auth_tbl_User (iUserId,email) VALUES (7,'old@x.tld');
    INSERT INTO auth_tbl_Session (sSessionId,iUserId,iOrgId,dtExpires) VALUES ('legacy-session',7,1,DATE_ADD(NOW(),INTERVAL 1 DAY));
    CREATE TABLE sms_tbl_Message (iMessageId BIGINT PRIMARY KEY,body TEXT);INSERT INTO sms_tbl_Message VALUES (100,'Preserved history');`);
    await pool.query(sql('012_platform_identity_mappings.sql'));
    await pool.query(sql('012_platform_identity_mappings.sql'));
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-map-test-'));
  });
  afterAll(async () => {
    await pool?.end();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });
  async function importMap(data: unknown, apply = false) {
    const file = path.join(temp, `manifest-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    return run(
      process.execPath,
      [
        path.join(source!, 'scripts/import-platform-mappings.mjs'),
        file,
        ...(apply ? ['--apply'] : []),
      ],
      { env: { ...process.env, ECHO_DB_URL: dbUrl } },
    );
  }
  it('is additive/idempotent and leaves historical user/session/message data intact', async () => {
    const [sessions] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT sSessionId FROM auth_tbl_Session',
    );
    expect(sessions[0].sSessionId).toBe('legacy-session');
    const [messages] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT body FROM sms_tbl_Message',
    );
    expect(messages[0].body).toBe('Preserved history');
    const [tables] = await pool.query<mysql.RowDataPacket[]>(
      "SHOW TABLES LIKE 'identity_%'",
    );
    expect(tables).toHaveLength(0);
  });
  it('validates without writes by default, then commits repeatable reviewed mappings', async () => {
    const manifest = {
      organizations: orgs,
      users: [{ iEchoUserId: 7, iPlatformUserId: 91 }],
    };
    await importMap(manifest);
    expect(await availableBusinesses(pool, identity([11, 22]))).toEqual([]);
    await importMap(manifest, true);
    await importMap(manifest, true);
    expect(
      (await availableBusinesses(pool, identity([11]))).map(
        (b) => b.iBusinessNumber,
      ),
    ).toEqual([7145550001]);
    expect(
      (await availableBusinesses(pool, identity([22]))).map(
        (b) => b.iBusinessNumber,
      ),
    ).toEqual([7145550002]);
  });
  it('rejects canonical-ID remapping, changed source numbers and unsafe IDs atomically', async () => {
    await expect(
      importMap(
        { organizations: [{ ...orgs[0], iTenantId: 22 }], users: [] },
        true,
      ),
    ).rejects.toThrow();
    await expect(
      importMap(
        {
          organizations: [{ ...orgs[0], iBusinessNumber: 7145550099 }],
          users: [],
        },
        true,
      ),
    ).rejects.toThrow();
    await expect(
      importMap(
        {
          organizations: [],
          users: [{ iEchoUserId: 7, iPlatformUserId: 9007199254740992 }],
        },
        true,
      ),
    ).rejects.toThrow();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT iTenantId FROM echo_tbl_PlatformOrgMap WHERE iOrgId=1',
    );
    expect(rows[0].iTenantId).toBe(11);
  });
  it('supports several reviewed numbers in one tenant and refuses number reassignment', async () => {
    await pool.query(
      'INSERT INTO auth_tbl_Org (iOrgId,iBusinessNumber) VALUES (3,7145550003)',
    );
    await importMap(
      {
        organizations: [
          { iOrgId: 3, iTenantId: 11, iBusinessNumber: 7145550003 },
        ],
        users: [],
      },
      true,
    );
    expect(await availableBusinesses(pool, identity([11]))).toHaveLength(2);
    await pool.query(
      'UPDATE auth_tbl_Org SET iBusinessNumber=7145550099 WHERE iOrgId=3',
    );
    await expect(availableBusinesses(pool, identity([11]))).rejects.toThrow(
      'reconciliation',
    );
  });
});
