import { createRequire } from 'node:module';

import { collectPerformanceEnvironment } from '../../../scripts/performance-report-support.mjs';

const require = createRequire(import.meta.url);
const playwrightPackage = require('playwright/package.json');

export function collectBrowserPerformanceEnvironment({
  repoRoot,
  browserVersion,
}) {
  return collectPerformanceEnvironment({
    repoRoot,
    runtime: {
      playwright: playwrightPackage.version,
      browser: browserVersion,
    },
  });
}
