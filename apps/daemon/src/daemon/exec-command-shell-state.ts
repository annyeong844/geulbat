import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ExecCommandShellMode = 'isolated' | 'persistent';

export type PreparePersistentShellInvocationResult =
  | {
      ok: true;
      executable: string;
      args: string[];
    }
  | {
      ok: false;
      reasonCode:
        | 'persistent_shell_platform_unsupported'
        | 'persistent_shell_state_root_invalid';
      message: string;
    };

interface PreparePersistentShellInvocationArgs {
  command: string;
  environment: NodeJS.ProcessEnv;
  explicitCwd: string | undefined;
  shellExecutable: string;
  stateRoot: string;
  threadId: string;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

const SHELL_STATE_DIRECTORY = 'exec-command-shell-state';

const RESTORE_SHELL_STATE_SCRIPT = String.raw`
const fs = require('node:fs');

const statePath = process.argv[1];
const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const isRecord = (candidate) =>
  typeof candidate === 'object' &&
  candidate !== null &&
  !Array.isArray(candidate);
const isEnvironmentName = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
const shellQuote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const allowedKeys = new Set([
  'schemaVersion',
  'cwd',
  'exportedEnv',
  'unsetEnv',
  'aliases',
  'functions',
]);

if (
  !isRecord(value) ||
  Object.keys(value).some((key) => !allowedKeys.has(key)) ||
  value.schemaVersion !== 1 ||
  typeof value.cwd !== 'string' ||
  !isRecord(value.exportedEnv) ||
  !Array.isArray(value.unsetEnv) ||
  typeof value.aliases !== 'string' ||
  typeof value.functions !== 'string'
) {
  throw new Error('persistent shell state is invalid');
}

const exportedEntries = Object.entries(value.exportedEnv);
if (
  exportedEntries.some(
    ([name, entry]) => !isEnvironmentName(name) || typeof entry !== 'string',
  ) ||
  value.unsetEnv.some(
    (name) => typeof name !== 'string' || !isEnvironmentName(name),
  )
) {
  throw new Error('persistent shell environment state is invalid');
}

const lines = ['cd -- ' + shellQuote(value.cwd)];
for (const name of [...value.unsetEnv].sort()) {
  lines.push('unset ' + name);
}
for (const [name, entry] of exportedEntries.sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  lines.push('export ' + name + '=' + shellQuote(entry));
}
if (value.functions.trim().length > 0) {
  lines.push(value.functions);
}
if (value.aliases.trim().length > 0) {
  lines.push(value.aliases);
}
process.stdout.write(lines.join('\n'));
`.trim();

const CAPTURE_SHELL_STATE_SCRIPT = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [statePath, baselineEncoded, aliasesPath, functionsPath] =
  process.argv.slice(1);
const baseline = JSON.parse(
  Buffer.from(baselineEncoded, 'base64url').toString('utf8'),
);
const isRecord = (candidate) =>
  typeof candidate === 'object' &&
  candidate !== null &&
  !Array.isArray(candidate);
const isEnvironmentName = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
const ignoredEnvironmentNames = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
const shouldIgnoreEnvironmentName = (name) =>
  ignoredEnvironmentNames.has(name) || name.startsWith('BASH_FUNC_');
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

if (
  !isRecord(baseline) ||
  Object.entries(baseline).some(
    ([name, value]) =>
      !isEnvironmentName(name) ||
      typeof value !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value),
  )
) {
  throw new Error('persistent shell environment baseline is invalid');
}

const exportedEnv = {};
for (const [name, value] of Object.entries(process.env)) {
  if (
    typeof value !== 'string' ||
    !isEnvironmentName(name) ||
    shouldIgnoreEnvironmentName(name)
  ) {
    continue;
  }
  if (baseline[name] !== digest(value)) {
    exportedEnv[name] = value;
  }
}
const unsetEnv = Object.keys(baseline)
  .filter(
    (name) =>
      isEnvironmentName(name) &&
      !shouldIgnoreEnvironmentName(name) &&
      process.env[name] === undefined,
  )
  .sort();
const state = {
  schemaVersion: 1,
  cwd: process.cwd(),
  exportedEnv: Object.fromEntries(
    Object.entries(exportedEnv).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ),
  unsetEnv,
  aliases: fs.readFileSync(aliasesPath, 'utf8'),
  functions: fs.readFileSync(functionsPath, 'utf8'),
};

const directory = path.dirname(statePath);
const directoryStats = fs.lstatSync(directory);
if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
  throw new Error('persistent shell state directory is invalid');
}
const temporaryPath =
  statePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
let handle;
try {
  handle = fs.openSync(temporaryPath, 'wx', 0o600);
  fs.writeFileSync(handle, JSON.stringify(state) + '\n', 'utf8');
  fs.fsyncSync(handle);
  fs.closeSync(handle);
  handle = undefined;
  fs.renameSync(temporaryPath, statePath);
  fs.chmodSync(statePath, 0o600);
  const directoryHandle = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(directoryHandle);
  } finally {
    fs.closeSync(directoryHandle);
  }
} catch (error) {
  if (handle !== undefined) {
    fs.closeSync(handle);
  }
  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch {
    // Preserve the original capture failure.
  }
  throw error;
}
`.trim();

const PERSISTENT_SHELL_COMMAND_SCRIPT = String.raw`
state_path=$1
node_executable=$2
restore_script=$3
capture_script=$4
user_command=$5
explicit_cwd=$6
baseline_encoded=$7
aliases_path="$state_path.$$-aliases.tmp"
functions_path="$state_path.$$-functions.tmp"

umask 077
rm -f \
  "$state_path".*-aliases.tmp \
  "$state_path".*-functions.tmp \
  "$state_path".*.tmp
if [ -r "$state_path" ]; then
  restore_commands=$("$node_executable" -e "$restore_script" "$state_path")
  restore_status=$?
  if [ "$restore_status" -ne 0 ]; then
    printf '%s\n' 'geulbat: persistent shell state restore failed; command was not started.' >&2
    exit 125
  fi
  eval "$restore_commands"
  restore_status=$?
  if [ "$restore_status" -ne 0 ]; then
    printf '%s\n' 'geulbat: persistent shell state could not be applied; command was not started.' >&2
    exit 125
  fi
fi

if [ -n "$explicit_cwd" ]; then
  if ! cd -- "$explicit_cwd"; then
    printf '%s\n' 'geulbat: explicit persistent shell cwd could not be entered; command was not started.' >&2
    exit 125
  fi
fi

if command -v shopt >/dev/null 2>&1; then
  shopt -s expand_aliases
fi
eval "$user_command"
user_status=$?
set +e

alias -p >"$aliases_path" 2>/dev/null || : >"$aliases_path"
{
  typeset -f 2>/dev/null ||
    declare -f 2>/dev/null ||
    true
} >"$functions_path"

"$node_executable" -e "$capture_script" \
  "$state_path" \
  "$baseline_encoded" \
  "$aliases_path" \
  "$functions_path"
capture_status=$?
rm -f "$aliases_path" "$functions_path"
if [ "$capture_status" -ne 0 ]; then
  printf '%s\n' 'geulbat: command finished, but persistent shell state capture failed; the previous state was kept.' >&2
  if [ "$user_status" -eq 0 ]; then
    exit 125
  fi
fi
exit "$user_status"
`.trim();

export async function preparePersistentShellInvocation(
  args: PreparePersistentShellInvocationArgs,
): Promise<PreparePersistentShellInvocationResult> {
  if ((args.platform ?? process.platform) === 'win32') {
    return {
      ok: false,
      reasonCode: 'persistent_shell_platform_unsupported',
      message:
        'exec_command persistent shell mode is currently available only on POSIX hosts.',
    };
  }
  const stateDirectory = resolveExecCommandPersistentShellStateDirectory(args);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(stateDirectory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    return {
      ok: false,
      reasonCode: 'persistent_shell_state_root_invalid',
      message:
        'exec_command persistent shell state root is not a regular directory.',
    };
  }
  await chmod(stateDirectory, 0o700);

  const statePath = join(stateDirectory, 'state.json');
  const baselineEncoded = Buffer.from(
    JSON.stringify(buildEnvironmentBaseline(args.environment)),
    'utf8',
  ).toString('base64url');
  return {
    ok: true,
    executable: 'flock',
    args: [
      '--exclusive',
      `${statePath}.lock`,
      args.shellExecutable,
      '-c',
      PERSISTENT_SHELL_COMMAND_SCRIPT,
      'geulbat-persistent-shell',
      statePath,
      args.nodeExecutable ?? process.execPath,
      RESTORE_SHELL_STATE_SCRIPT,
      CAPTURE_SHELL_STATE_SCRIPT,
      args.command,
      args.explicitCwd ?? '',
      baselineEncoded,
    ],
  };
}

export function resolveExecCommandPersistentShellStateDirectory(args: {
  stateRoot: string;
  threadId: string;
}): string {
  return join(
    args.stateRoot,
    '.geulbat',
    SHELL_STATE_DIRECTORY,
    digestIdentity(args.threadId),
  );
}

export async function deleteExecCommandPersistentShellState(args: {
  stateRoot: string;
  threadId: string;
}): Promise<boolean> {
  const stateDirectory = resolveExecCommandPersistentShellStateDirectory(args);
  try {
    await lstat(stateDirectory);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
  await rm(stateDirectory, { recursive: true, force: true });
  try {
    await rmdir(join(args.stateRoot, '.geulbat', SHELL_STATE_DIRECTORY));
  } catch (error) {
    if (
      getErrorCode(error) !== 'ENOENT' &&
      getErrorCode(error) !== 'ENOTEMPTY'
    ) {
      throw error;
    }
  }
  return true;
}

function buildEnvironmentBaseline(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || !isEnvironmentName(name)) {
      continue;
    }
    entries.push([name, createHash('sha256').update(value).digest('hex')]);
  }
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
