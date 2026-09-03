import { buildApp } from './app';
import { loadEnv, refreshConfig } from './config';
import { getDb } from './db';

const RETRY_DELAY_MS = 5_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the settings or die.
 *
 * Everything this app needs beyond the database's own address — its OAuth
 * credentials, where EchoService lives, the public URLs — is a row in
 * echo_tbl_Settings. There is no fallback: starting without them would mean
 * answering every request with a fault we could not explain. One retry covers
 * the ordinary case of the database still coming up beside us; after that,
 * exit saying why.
 */
async function main() {
  const env = loadEnv();
  const db = getDb(env);

  for (let attempt = 1; ; attempt++) {
    try {
      await refreshConfig(db);
      console.log('[settings] echo_tbl_Settings read');
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
        '[settings] Cannot start. Check DB_HOST/DB_USER/DB_NAME for the Echo database, ' +
          'and that echo_tbl_Settings exists in it.'
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
