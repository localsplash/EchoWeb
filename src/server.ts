import { buildApp } from './app';
import { loadEnv, refreshConfig } from './config';
import { getDb } from './db';

const RETRY_DELAY_MS = 5_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Require PlatformConfig at startup; retry once, then exit on failure. */
async function main() {
  const env = loadEnv();
  getDb(env); // Validate application database bootstrap.

  for (let attempt = 1; ; attempt++) {
    try {
      await refreshConfig();
      console.log('[settings] PlatformConfig configuration read');
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 1) {
        console.warn(`[settings] ${message} — retrying once in ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      console.error(`[settings] ${message}`);
      console.error(
        '[settings] Cannot start. Check application DB coordinates and service-owned ' +
          'NOCODB_BASE_URL/NOCODB_API_TOKEN for PlatformConfig/cfg_tbl_Setting.'
      );
      process.exit(1);
    }
  }

  const app = buildApp();
  app.listen(env.PORT, () => {
    console.log(`EchoWeb listening on :${env.PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
