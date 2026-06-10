import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ENV_LOCAL = resolve(MODULE_DIR, '..', '.env.local');
const REPO_ENV_LOCAL = resolve(MODULE_DIR, '../../..', '.env.local');

export async function loadDaemonLocalEnv(options?: {
  candidateFiles?: readonly string[];
}): Promise<void> {
  const candidateFiles = options?.candidateFiles ?? [
    APP_ENV_LOCAL,
    REPO_ENV_LOCAL,
  ];

  for (const candidateFile of candidateFiles) {
    await applyEnvFile(candidateFile);
  }
}

async function applyEnvFile(filePath: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }

  for (const line of contents.split(/\r?\n/u)) {
    const parsed = parseEnvAssignment(line);
    if (!parsed) {
      continue;
    }
    if (process.env[parsed.key] !== undefined) {
      continue;
    }
    process.env[parsed.key] = parsed.value;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function parseEnvAssignment(
  line: string,
): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }

  const [, key, rawValue] = match;
  if (!key) {
    return null;
  }

  return {
    key,
    value: normalizeEnvValue(rawValue ?? ''),
  };
}

function normalizeEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeDoubleQuotedEnvValue(trimmed.slice(1, -1));
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  const commentIndex = trimmed.indexOf(' #');
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trimEnd() : trimmed;
}

function unescapeDoubleQuotedEnvValue(value: string): string {
  let normalized = '';

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (current !== '\\' || next === undefined) {
      normalized += current;
      continue;
    }

    switch (next) {
      case 'n':
        normalized += '\n';
        break;
      case 'r':
        normalized += '\r';
        break;
      case 't':
        normalized += '\t';
        break;
      case '"':
        normalized += '"';
        break;
      case '\\':
        normalized += '\\';
        break;
      default:
        normalized += `\\${next}`;
        break;
    }

    index += 1;
  }

  return normalized;
}
