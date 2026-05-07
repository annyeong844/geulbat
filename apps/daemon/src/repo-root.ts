import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, '../../..');

export function readDefaultRepoRoot(): string {
  return resolve(process.env['GEULBAT_REPO_ROOT'] ?? DEFAULT_REPO_ROOT);
}
