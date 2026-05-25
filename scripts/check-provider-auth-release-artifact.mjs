#!/usr/bin/env node

import process from 'node:process';

import {
  readApprovedProviderAuthClientIdFile,
  validateProviderAuthReleaseArtifact,
} from './provider-auth-release-validation.mjs';

const args = process.argv.slice(2);

try {
  const options = parseArgs(args);
  const approvedClientIds = [
    ...options.approvedClientIds,
    ...(options.approvedClientIdFile
      ? await readApprovedProviderAuthClientIdFile(options.approvedClientIdFile)
      : []),
  ];
  await validateProviderAuthReleaseArtifact({
    approvedClientIds,
    artifactRoot: options.artifactRoot,
    bundledConfigPath: options.bundledConfigPath,
  });
  console.log('provider auth release validation passed');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(input) {
  let artifactRoot = null;
  let approvedClientIdFile = null;
  let bundledConfigPath = null;
  const approvedClientIds = [];

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    switch (current) {
      case '--artifact-root':
        artifactRoot = readOptionValue(current, next);
        index += 1;
        break;
      case '--approved-client-id':
        approvedClientIds.push(readOptionValue(current, next));
        index += 1;
        break;
      case '--approved-client-id-file':
        approvedClientIdFile = readOptionValue(current, next);
        index += 1;
        break;
      case '--bundled-config-path':
        bundledConfigPath = readOptionValue(current, next);
        index += 1;
        break;
      case '--help':
        throw new Error(readUsage());
      default:
        throw new Error(`unknown argument: ${current}\n${readUsage()}`);
    }
  }

  if (!artifactRoot) {
    throw new Error(`--artifact-root is required\n${readUsage()}`);
  }
  if (approvedClientIds.length === 0 && !approvedClientIdFile) {
    throw new Error(
      `--approved-client-id or --approved-client-id-file is required\n${readUsage()}`,
    );
  }

  return {
    approvedClientIdFile,
    approvedClientIds,
    artifactRoot,
    bundledConfigPath,
  };
}

function readOptionValue(name, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value\n${readUsage()}`);
  }
  return value;
}

function readUsage() {
  return [
    'Usage:',
    '  node scripts/check-provider-auth-release-artifact.mjs --artifact-root <path> (--approved-client-id <client-id> | --approved-client-id-file <path>) [--bundled-config-path <path>]',
    '',
    'Repeat --approved-client-id for each approved release-channel client id.',
    'Use --approved-client-id-file to read tracked release metadata.',
  ].join('\n');
}
