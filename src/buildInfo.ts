import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const metadataPath = join(__dirname, 'build-info.json');
// Source development is explicitly unbuilt; production metadata is stamped by the build.
export const buildInfo = Object.freeze(existsSync(metadataPath)
  ? JSON.parse(readFileSync(metadataPath, 'utf8'))
  : { version: 'unbuilt', revision: null, sourceUpdatedAt: null, timeZone: 'America/Los_Angeles', dirty: null });
