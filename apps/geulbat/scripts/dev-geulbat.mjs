#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDaemonDevBundleBuilder,
  getDaemonDevWatchRoots,
} from '../../daemon/scripts/dev-daemon-bundle.mjs';
import { runDaemonDevSupervisor } from '../../daemon/scripts/dev-daemon-supervisor.mjs';

const productRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(productRoot, '../..');
const sourceRoots = [
  resolve(productRoot, 'src'),
  ...getDaemonDevWatchRoots(repoRoot),
];

process.exitCode = await runDaemonDevSupervisor({
  root: productRoot,
  sourceRoots,
  createBundleBuilder: ({ reportInfo }) =>
    createDaemonDevBundleBuilder({
      root: repoRoot,
      appRoot: productRoot,
      entryPoint: resolve(productRoot, 'src/index.ts'),
      sourceRoots,
      reportInfo,
    }),
});
