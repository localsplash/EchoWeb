import fs from 'node:fs';
import path from 'node:path';

/**
 * The bootstrap file — how this app finds the settings base it cannot read an
 * address out of.
 *
 * Deliberately the same two keys, the same path and the same precedence as
 * identity's `src/localConfig.ts` and EchoService's `src/localConfig.js`.
 * Three apps that bootstrap identically can share one file, which is what
 * makes a single-host install zero-config: identity's `/setup` writes it, and
 * this app finds it already mounted read-only at `/data`.
 *
 * Environment first, so a deployment that states these as variables keeps
 * doing so and never grows a file it did not ask for. Blank counts as unset.
 *
 * There is no wizard here. Unlike EchoService, EchoWeb has nothing to ask
 * that identity has not already been asked — and on a host where the volume
 * cannot be shared, stating two environment variables is the whole job.
 */
export const LOCAL_CONFIG_PATH =
  process.env.ECHO_CONFIG_PATH || path.join(process.env.ECHO_CONFIG_DIR || '/data', 'config.json');

const KEYS = ['NOCODB_BASE_URL', 'NOCODB_API_TOKEN'] as const;

/**
 * Fold the bootstrap file into the environment. A missing file is the
 * ordinary case — the environment may already carry these, or this may be a
 * deployment that does not need them yet — so it is not an error. A corrupt
 * one is an operator's problem and says so rather than looking like an app
 * that forgot its configuration.
 */
export function applyLocalConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: string = LOCAL_CONFIG_PATH
): void {
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
