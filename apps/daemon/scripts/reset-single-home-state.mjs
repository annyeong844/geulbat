import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEGACY_PROJECT_STATE_FAMILIES = [
  'artifact-runtime-state-inputs',
  'file-binary-inputs',
  'index',
  'ptc',
  'react-bundle-inline-compile-inputs',
  'run-prompt-inputs',
  'sandbox-outputs',
  'sessions',
  'tool-library',
  'tool-outputs',
  'tool-state',
];

const PRESERVED_ROOT_STATE_ENTRIES = new Set([
  'daemon-admission-lock.json',
  'dev',
  'dev-auth-token',
  'dev-auth-token.bak',
]);

const PROJECT_REGISTRY_PATH = '.geulbat/projects.json';
const DEFAULT_LEGACY_PROJECT_ID = 'workspace';

export async function planSingleHomeLegacyStateReset(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const registryPath = join(repoRoot, PROJECT_REGISTRY_PATH);
  const projectIds = await readLegacyProjectIds(registryPath);
  projectIds.add(DEFAULT_LEGACY_PROJECT_ID);

  const targets = [];
  const unknownEntries = [];
  for (const projectId of [...projectIds].sort()) {
    const projectRoot = resolveLegacyProjectRoot(repoRoot, projectId);
    const internalRoot = join(projectRoot, '.geulbat');
    for (const family of LEGACY_PROJECT_STATE_FAMILIES) {
      const target = join(internalRoot, family);
      const kind = await readResetTargetKind(target);
      if (kind !== null) {
        targets.push({
          kind,
          relativePath: toRepoRelativePath(repoRoot, target),
        });
      }
    }

    for (const entry of await listDirectoryNames(internalRoot)) {
      if (!LEGACY_PROJECT_STATE_FAMILIES.includes(entry)) {
        unknownEntries.push(
          toRepoRelativePath(repoRoot, join(internalRoot, entry)),
        );
      }
    }
  }

  const registryKind = await readResetTargetKind(registryPath);
  if (registryKind !== null) {
    targets.push({
      kind: registryKind,
      relativePath: PROJECT_REGISTRY_PATH,
    });
  }

  const rootInternalPath = join(repoRoot, '.geulbat');
  for (const entry of await listDirectoryNames(rootInternalPath)) {
    if (entry === 'projects.json' || PRESERVED_ROOT_STATE_ENTRIES.has(entry)) {
      continue;
    }
    const target = join(rootInternalPath, entry);
    if (LEGACY_PROJECT_STATE_FAMILIES.includes(entry)) {
      const kind = await readResetTargetKind(target);
      if (kind !== null) {
        targets.push({
          kind,
          relativePath: toRepoRelativePath(repoRoot, target),
        });
      }
      continue;
    }
    unknownEntries.push(toRepoRelativePath(repoRoot, target));
  }

  return {
    repoRoot,
    daemonLockPresent:
      (await readResetTargetKind(
        join(repoRoot, '.geulbat', 'daemon-admission-lock.json'),
      )) !== null,
    projectIds: [...projectIds].sort(),
    targets: deduplicateTargets(targets),
    unknownEntries: [...new Set(unknownEntries)].sort(),
  };
}

export async function applySingleHomeLegacyStateReset(options = {}) {
  const plan = await planSingleHomeLegacyStateReset(options);
  if (plan.daemonLockPresent) {
    throw new Error(
      'single-home reset refused: stop the daemon and remove its admission lock first',
    );
  }
  if (plan.unknownEntries.length > 0) {
    throw new Error(
      `single-home reset refused: unknown .geulbat entries: ${plan.unknownEntries.join(', ')}`,
    );
  }

  for (const target of plan.targets) {
    await rm(join(plan.repoRoot, target.relativePath), {
      recursive: target.kind === 'directory',
      force: false,
    });
  }

  return {
    removed: plan.targets.map((target) => target.relativePath),
    preserved: [
      '.geulbat/dev',
      '.geulbat/dev-auth-token',
      '.geulbat/dev-auth-token.bak',
    ],
  };
}

async function readLegacyProjectIds(registryPath) {
  let value;
  try {
    value = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return new Set();
    }
    throw new Error(
      'single-home reset refused: project registry is unreadable',
      {
        cause: error,
      },
    );
  }

  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !Array.isArray(value.projects)
  ) {
    throw new Error('single-home reset refused: project registry is malformed');
  }

  const projectIds = new Set();
  for (const project of value.projects) {
    if (
      !project ||
      typeof project !== 'object' ||
      Array.isArray(project) ||
      typeof project.projectId !== 'string'
    ) {
      throw new Error(
        'single-home reset refused: project registry entry is malformed',
      );
    }
    assertSafeLegacyProjectId(project.projectId);
    projectIds.add(project.projectId);
  }
  return projectIds;
}

function resolveLegacyProjectRoot(repoRoot, projectId) {
  assertSafeLegacyProjectId(projectId);
  const projectRoot = resolve(repoRoot, projectId);
  const projectRelativePath = relative(repoRoot, projectRoot);
  if (
    projectRelativePath === '' ||
    projectRelativePath === '..' ||
    projectRelativePath.startsWith(`..${sep}`) ||
    resolve(repoRoot, projectRelativePath) !== projectRoot
  ) {
    throw new Error(
      'single-home reset refused: project root escaped repo root',
    );
  }
  return projectRoot;
}

function assertSafeLegacyProjectId(projectId) {
  if (
    projectId.length === 0 ||
    basename(projectId) !== projectId ||
    projectId === '.' ||
    projectId === '..'
  ) {
    throw new Error('single-home reset refused: unsafe legacy project id');
  }
}

async function readResetTargetKind(path) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      throw new Error('single-home reset refused: symlink target detected');
    }
    if (entry.isDirectory()) {
      return 'directory';
    }
    if (entry.isFile()) {
      return 'file';
    }
    throw new Error('single-home reset refused: unsupported target kind');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function listDirectoryNames(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).map(
      (entry) => entry.name,
    );
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function toRepoRelativePath(repoRoot, path) {
  const result = relative(repoRoot, path);
  if (
    result === '' ||
    result === '..' ||
    result.startsWith(`..${sep}`) ||
    resolve(repoRoot, result) !== resolve(path)
  ) {
    throw new Error('single-home reset refused: target escaped repo root');
  }
  return result.split(sep).join('/');
}

function deduplicateTargets(targets) {
  return [
    ...new Map(targets.map((target) => [target.relativePath, target])).values(),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function readCliOptions(argv) {
  let repoRoot;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--root requires a path');
      }
      repoRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { apply, repoRoot };
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  if (!options.apply) {
    const plan = await planSingleHomeLegacyStateReset(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          daemonLockPresent: plan.daemonLockPresent,
          projectIds: plan.projectIds,
          targets: plan.targets,
          unknownEntries: plan.unknownEntries,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const result = await applySingleHomeLegacyStateReset(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
