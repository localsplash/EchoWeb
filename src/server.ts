import { buildApp } from './app';
import { loadEnv, refreshConfig } from './config';
import { SETTINGS_BASE_NAME, SETTINGS_TABLE_NAME } from './settings';

const RETRY_DELAY_MS = 5_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Find the settings or die.
 *
 * Every value this app needs — its database, its OAuth credentials, where
 * EchoService lives — is a row in IdentityBase.auth_tbl_Settings. There is no
 * fallback: starting without them would mean answering every request with a
 * fault we could not explain. One retry covers the ordinary case of NocoDB
 * still coming up beside us; after that, exit saying why.
 */
async function main() {
  const env = loadEnv();

  for (let attempt = 1; ; attempt++) {
    try {
      await refreshConfig();
      console.log(`[settings] ${SETTINGS_BASE_NAME}.${SETTINGS_TABLE_NAME} read`);
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
        `[settings] Cannot start without the ${SETTINGS_BASE_NAME} base at ` +
          `${env.NOCODB_BASE_URL}. Fix NOCODB_BASE_URL / NOCODB_API_TOKEN, or create the ` +
          'base (its name must be unique), then start again.'
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
