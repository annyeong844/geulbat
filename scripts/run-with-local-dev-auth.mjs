#!/usr/bin/env node

import { spawn } from 'node:child_process';

import { createLocalDevAuthEnv } from './local-dev-auth-token.mjs';

const [, , command, ...args] = process.argv;

if (!command) {
  console.error(
    'usage: node scripts/run-with-local-dev-auth.mjs <command> [...args]',
  );
  process.exit(2);
}

let env;
try {
  env = createLocalDevAuthEnv(process.env);
} catch (error) {
  console.error(`[geulbat-dev-auth] ${getErrorMessage(error)}`);
  process.exit(1);
}

const child = spawn(command, args, {
  env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(
    `[geulbat-dev-auth] failed to start ${command}: ${error.message}`,
  );
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (typeof code === 'number') {
    process.exit(code);
  }
  if (signal) {
    console.error(`[geulbat-dev-auth] ${command} exited with signal ${signal}`);
  }
  process.exit(1);
});

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
