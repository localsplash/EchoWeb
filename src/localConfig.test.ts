import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyLocalConfig } from './localConfig';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function file(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-web-bootstrap-'));
  directories.push(dir);
  const target = path.join(dir, 'config.json');
  fs.writeFileSync(target, body);
  return target;
}
describe('service-owned NocoDB bootstrap', () => {
  it('ignores the optional file when both environment credentials are provided', () => {
    const env = { NOCODB_BASE_URL: 'http://nocodb', NOCODB_API_TOKEN: 'token' };
    expect(() => applyLocalConfig(env, file('invalid JSON'))).not.toThrow();
    expect(env).toEqual({ NOCODB_BASE_URL: 'http://nocodb', NOCODB_API_TOKEN: 'token' });
  });
  it('fills missing credentials from the optional file without replacing the environment', () => {
    const env: NodeJS.ProcessEnv = { NOCODB_BASE_URL: 'http://override' };
    applyLocalConfig(env, file(JSON.stringify({ NOCODB_BASE_URL: 'http://file', NOCODB_API_TOKEN: 'file-token', DB_PASSWORD: 'ignored' })));
    expect(env).toEqual({ NOCODB_BASE_URL: 'http://override', NOCODB_API_TOKEN: 'file-token' });
  });
  it('still rejects a corrupt file when bootstrap depends on it', () => {
    expect(() => applyLocalConfig({}, file('invalid JSON'))).toThrow('not valid JSON');
  });
});
