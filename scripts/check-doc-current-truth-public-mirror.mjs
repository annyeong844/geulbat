#!/usr/bin/env node

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PRIVATE_DOC_PATHS = [
  'docs/current/spec/phase5',
  'docs/current/spec/phase7-shell-redesign',
  'docs/current/audit',
];

for (const relativePath of PRIVATE_DOC_PATHS) {
  if (await pathExists(path.resolve(process.cwd(), relativePath))) {
    throw new Error(
      `public mirror must not export private docs path: ${relativePath}`,
    );
  }
}

console.log('public mirror docs profile check passed (private docs omitted)');

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
