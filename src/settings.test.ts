import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlatformSettingsStore } from './settings';
const config = { NOCODB_BASE_URL: 'http://nocodb', NOCODB_API_TOKEN: 'token' };
afterEach(() => vi.unstubAllGlobals());
function stub(rows: unknown[], legacy = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/meta/bases')
          ? {
              list: [
                {
                  id: 'base',
                  title: legacy ? 'IdentityBase' : 'PlatformConfig',
                },
              ],
            }
          : url.endsWith('/tables')
            ? {
                list: [
                  {
                    id: 'table',
                    title: legacy ? 'auth_tbl_Settings' : 'cfg_tbl_Setting',
                  },
                ],
              }
            : { list: rows, pageInfo: { isLastPage: true } },
    })),
  );
}
describe('explicit PlatformConfig rollout', () => {
  it('resolves exact EchoWeb scope over declared Echo parent and global without reading sibling secrets', async () => {
    stub([
      { app: '*', settingKey: 'PARENT_DOMAIN', settingValue: 'x.tld' },
      { app: 'echo', settingKey: 'PUSHER_KEY', settingValue: 'shared' },
      { app: 'echo-web', settingKey: 'PUSHER_KEY', settingValue: 'web' },
      { app: 'echo-web', settingKey: 'PARENT_DOMAIN', settingValue: '' },
      {
        app: 'identity',
        settingKey: 'GOOGLE_CLIENT_SECRET',
        settingValue: 'private',
      },
    ]);
    expect(await new PlatformSettingsStore(config).get()).toEqual({
      PARENT_DOMAIN: 'x.tld',
      PUSHER_KEY: 'web',
    });
  });
  it('fails on duplicate scoped keys', async () => {
    stub([
      { app: 'echo-web', settingKey: 'KEY', settingValue: 'a' },
      { app: 'echo-web', settingKey: 'KEY', settingValue: 'a' },
    ]);
    await expect(new PlatformSettingsStore(config).get()).rejects.toThrow(
      'Duplicate',
    );
  });
  it('has no legacy source even when only IdentityBase is available', async () => {
    stub([{ Key: 'PARENT_DOMAIN', Value: 'old.tld' }], true);
    await expect(new PlatformSettingsStore(config).get()).rejects.toThrow('PlatformConfig');
  });
});
