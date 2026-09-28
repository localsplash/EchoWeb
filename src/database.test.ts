import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from './app';
import { refreshConfig, invalidateConfig, loadEnv } from './config';
import { getDb } from './db';

const fake = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), createPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: { createPool: fake.createPool } }));
let rows: Array<{ app: string; settingKey: string; settingValue: string }>;
beforeEach(() => {
  invalidateConfig();
  vi.stubEnv('NOCODB_BASE_URL', 'http://settings.example');
  vi.stubEnv('NOCODB_API_TOKEN', 'test-token');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DB_HOST', 'stale-env');
  vi.stubEnv('DB_PASSWORD', 'stale-secret');
  fake.createPool.mockReset().mockReturnValue({ query: fake.query, end: fake.end });
  fake.query.mockReset().mockResolvedValue([[]]);
  rows = [{ app: '*', settingKey: 'PARENT_DOMAIN', settingValue: 'example.org' }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({
    list: url.endsWith('/meta/bases') ? [{ id: 'base', title: 'PlatformConfig' }]
      : url.endsWith('/tables') ? [{ id: 'table', title: 'cfg_tbl_Setting' }] : rows,
    pageInfo: { isLastPage: true },
  }))));
});
afterEach(async () => { await getDb().end(); invalidateConfig(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('starts without DB rows and reports unconfigured readiness without opening a pool', async () => {
  const config = await refreshConfig();
  expect(config.DB_HOST).toBe('lsdb.example.org');
  expect(loadEnv()).not.toHaveProperty('DB_HOST');
  const app = buildApp();
  expect((await request(app).get('/healthz')).status).toBe(200);
  const response = await request(app).get('/readyz');
  expect(response.status).toBe(503);
  expect(response.body.reason).toBe('database_unconfigured');
  expect(fake.createPool).not.toHaveBeenCalled();
});

it('uses scoped DB rows lazily, retains an open pool, and distinguishes connection failures', async () => {
  rows.push(
    { app: 'echo', settingKey: 'DB_HOST', settingValue: 'shared-db' },
    { app: 'echo-web', settingKey: 'DB_HOST', settingValue: 'web-db' },
    { app: 'echo-web', settingKey: 'DB_USER', settingValue: 'echo_web' },
    { app: 'echo-web', settingKey: 'DB_PASSWORD', settingValue: 'row-secret' },
    { app: 'echo', settingKey: 'DB_NAME', settingValue: 'echo_db' },
    { app: 'echo-service', settingKey: 'DB_PASSWORD', settingValue: 'other-secret' },
  );
  await refreshConfig();
  const app = buildApp();
  expect(fake.createPool).not.toHaveBeenCalled();
  expect((await request(app).get('/readyz')).status).toBe(200);
  expect(fake.createPool).toHaveBeenCalledWith(expect.objectContaining({ host: 'web-db', user: 'echo_web', password: 'row-secret', port: 3306 }));
  rows.find((row) => row.app === 'echo-web' && row.settingKey === 'DB_HOST')!.settingValue = 'new-db';
  invalidateConfig();
  await refreshConfig();
  fake.query.mockRejectedValue(new Error('ECONNREFUSED'));
  const response = await request(app).get('/readyz');
  expect(response.status).toBe(503);
  expect(response.body.reason).toBe('database_unreachable');
  expect(fake.createPool).toHaveBeenCalledTimes(1);
});
