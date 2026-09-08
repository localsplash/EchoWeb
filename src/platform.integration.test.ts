import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePlatformSession } from './platformSession';
import type { AppConfig } from './config';

const url = process.env.TEST_DB_URL;
const source = process.env.ECHO_DATABASE_SOURCE;
const retired = [
  'echo_tbl_Settings', 'echo_tbl_PlatformOrgMap', 'echo_tbl_PlatformUserMap',
  'auth_tbl_Identity', 'auth_tbl_Membership', 'auth_tbl_Session',
  'auth_tbl_SsoNonce', 'auth_tbl_User', 'auth_tbl_Org',
];
const retirement = '013_retire_legacy_configuration_and_auth.sql';

describe.skipIf(!url)('Echo Dev schema retirement (real MySQL)', () => {
  let pool: mysql.Pool;
  async function apply(name: string) {
    const text = fs.readFileSync(path.join(source!, 'init', name), 'utf8')
      .replaceAll('echo_db', 'echo_platform_test');
    // MySQL client DELIMITER directives are not SQL; execute each client chunk.
    let delimiter = ';', statement = '';
    for (const line of text.split('\n')) {
      const directive = line.match(/^DELIMITER\s+(\S+)\s*$/i);
      if (directive) { delimiter = directive[1]; continue; }
      statement += `${line}\n`;
      if (statement.trimEnd().endsWith(delimiter)) {
        const sql = statement.trimEnd().slice(0, -delimiter.length);
        if (sql.trim()) await pool.query(sql);
        statement = '';
      }
    }
  }
  async function tables() {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SHOW TABLES');
    return rows.map((row) => String(Object.values(row)[0]));
  }
  beforeAll(async () => {
    if (!source) throw new Error('Set ECHO_DATABASE_SOURCE to the matching EchoDatabase checkout');
    const parsed = new URL(url!);
    const admin = await mysql.createConnection({
      host: parsed.hostname, port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
    });
    // This test can recreate only its explicitly named disposable schema.
    await admin.query('DROP DATABASE IF EXISTS echo_platform_test');
    await admin.query('CREATE DATABASE echo_platform_test');
    await admin.end();
    parsed.pathname = '/echo_platform_test';
    pool = mysql.createPool({ uri: parsed.toString(), multipleStatements: true, timezone: 'Z' });
    for (const name of fs.readdirSync(path.join(source, 'init')).filter((name) => name.endsWith('.sql')).sort()) await apply(name);
  });
  afterAll(async () => { vi.unstubAllGlobals(); await pool?.end(); });

  it('fresh initialization creates messaging tables and routines without retired objects', async () => {
    const names = await tables();
    for (const name of retired) expect(names).not.toContain(name);
    expect(names).toContain('sms_tbl_Message');
    await pool.query('CALL sms_usp_Message_INS(?, ?, ?, ?, ?, ?, ?)', [
      'retirement-test', 1, 7145550001, 7145550002, 'Active messaging fixture', '2026-09-08 00:00:00.000', 1,
    ]);
    const [messages] = await pool.query<mysql.RowDataPacket[]>("SELECT text FROM sms_tbl_Message WHERE sMessageId='retirement-test'");
    expect(messages[0].text).toBe('Active messaging fixture');
  });

  it('drops populated legacy tables in FK order, retains messaging and ledger, and is repeatable', async () => {
    await pool.query(`
      CREATE TABLE auth_tbl_User (iUserId BIGINT PRIMARY KEY);
      CREATE TABLE auth_tbl_Org (iOrgId BIGINT PRIMARY KEY);
      CREATE TABLE auth_tbl_Identity (iIdentityId BIGINT PRIMARY KEY,iUserId BIGINT,FOREIGN KEY(iUserId) REFERENCES auth_tbl_User(iUserId));
      CREATE TABLE auth_tbl_Membership (iMembershipId BIGINT PRIMARY KEY,iUserId BIGINT,iOrgId BIGINT,FOREIGN KEY(iUserId) REFERENCES auth_tbl_User(iUserId),FOREIGN KEY(iOrgId) REFERENCES auth_tbl_Org(iOrgId));
      CREATE TABLE auth_tbl_Session (sSessionId VARCHAR(64) PRIMARY KEY);
      CREATE TABLE auth_tbl_SsoNonce (sNonce VARCHAR(32) PRIMARY KEY);
      CREATE TABLE echo_tbl_PlatformUserMap (iEchoUserId BIGINT PRIMARY KEY,FOREIGN KEY(iEchoUserId) REFERENCES auth_tbl_User(iUserId));
      CREATE TABLE echo_tbl_PlatformOrgMap (iOrgId BIGINT PRIMARY KEY,FOREIGN KEY(iOrgId) REFERENCES auth_tbl_Org(iOrgId));
      CREATE TABLE echo_tbl_Settings (sKey VARCHAR(128) PRIMARY KEY,sValue TEXT);
      CREATE TABLE echo_tbl_SchemaMigration (sFile VARCHAR(255) PRIMARY KEY);
      INSERT INTO auth_tbl_User VALUES (7); INSERT INTO auth_tbl_Org VALUES (8);
      INSERT INTO auth_tbl_Identity VALUES (1,7); INSERT INTO auth_tbl_Membership VALUES (1,7,8);
      INSERT INTO auth_tbl_Session VALUES ('obsolete'); INSERT INTO auth_tbl_SsoNonce VALUES ('obsolete');
      INSERT INTO echo_tbl_PlatformUserMap VALUES (7); INSERT INTO echo_tbl_PlatformOrgMap VALUES (8);
      INSERT INTO echo_tbl_Settings VALUES ('obsolete','discard this');
      INSERT INTO echo_tbl_SchemaMigration VALUES ('009_settings.sql');
    `);
    await apply(retirement);
    await apply(retirement);
    const names = await tables();
    for (const name of retired) expect(names).not.toContain(name);
    const [ledger] = await pool.query<mysql.RowDataPacket[]>('SELECT sFile FROM echo_tbl_SchemaMigration');
    expect(ledger[0].sFile).toBe('009_settings.sql');
    const [messages] = await pool.query<mysql.RowDataPacket[]>("SELECT text FROM sms_tbl_Message WHERE sMessageId='retirement-test'");
    expect(messages[0].text).toBe('Active messaging fixture');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      active: true, user: { iUserId: 91, email: null, displayName: null, superAdmin: false },
      tenants: [{ iTenantId: 11, name: 'Office', slug: 'office', role: 'USER', bEnabled: true }],
      selectedTenantId: 11,
      numbers: [{ iPhoneNumberId: 1, iTenantId: 11, phoneNumber: '+17145550001', label: '', bVoice: true, bMessaging: true, bEnabled: true, accessPolicy: 'TENANT_MEMBERS', iVersion: 1 }],
    }) })));
    const session = await resolvePlatformSession(pool, { IDENTITY_BASE_URL: 'http://identity' } as AppConfig, 'a'.repeat(64), null);
    expect(session?.iBusinessNumber).toBe(7145550001);
    expect(session?.iOrgId).toBeNull();
  });
});
