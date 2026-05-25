import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createProviderAuthBootstrapStore,
  type ProviderAuthBootstrapStore,
} from '../daemon/auth/bootstrap/session-store.js';
import {
  createProviderAuthRuntimeStore,
  type ProviderAuthRuntimeStore,
} from '../daemon/auth/runtime-state.js';

export interface ProviderAuthTestStores {
  bootstrapStore: ProviderAuthBootstrapStore;
  runtimeStore: ProviderAuthRuntimeStore;
}

const TEST_PROVIDER_AUTH_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'geulbat-provider-auth-test-'),
);
const TEST_PROVIDER_AUTH_FILE_PATH = path.join(
  TEST_PROVIDER_AUTH_DIR,
  'provider.json',
);

export function ensureTestProviderAuthFilePath(): string {
  if (!process.env['GEULBAT_PROVIDER_AUTH_FILE_PATH']) {
    process.env['GEULBAT_PROVIDER_AUTH_FILE_PATH'] =
      TEST_PROVIDER_AUTH_FILE_PATH;
  }
  return process.env['GEULBAT_PROVIDER_AUTH_FILE_PATH']!;
}

export function createProviderAuthTestStores(): ProviderAuthTestStores {
  ensureTestProviderAuthFilePath();
  return {
    bootstrapStore: createProviderAuthBootstrapStore(),
    runtimeStore: createProviderAuthRuntimeStore(),
  };
}
