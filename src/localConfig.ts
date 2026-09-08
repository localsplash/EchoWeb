import fs from 'node:fs';
import path from 'node:path';

/**
 * The bootstrap file — how this app finds the settings base whose address it
 * cannot read out of that base.
 *
 * The optional file is service-owned and carries only the NocoDB address and
 * read token. Normal deployment injects both keys without an Identity volume.
 *
 * Environment first, so a deployment that states these as variables never
 * grows a file it did not ask for. Blank counts as unset.
 */
export const LOCAL_CONFIG_PATH =
  process.env.ECHO_CONFIG_PATH || path.join(process.env.ECHO_CONFIG_DIR || '/data', 'config.json');

const KEYS = ['NOCODB_BASE_URL', 'NOCODB_API_TOKEN'] as const;

/**
 * Fold the bootstrap file into the environment. A missing file is the
 * ordinary case — the environment may already carry these — so it is not an
 * error. A corrupt one is an operator's problem and says so.
 */
export function applyLocalConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: string = LOCAL_CONFIG_PATH
): void {
  if (KEYS.every((key) => env[key]?.trim())) return;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(
      `${file} could not be read (${(err as Error).message}). It holds the address of ` +
        'the settings base, so this app will not guess past it: repair it, remove it, ' +
        'or state NOCODB_BASE_URL and NOCODB_API_TOKEN in the environment instead.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object.`);
  }
  for (const key of KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    const stated = env[key];
    if (
      typeof value === 'string' &&
      value.trim() !== '' &&
      (typeof stated !== 'string' || stated.trim() === '')
    ) {
      env[key] = value.trim();
    }
  }
}
