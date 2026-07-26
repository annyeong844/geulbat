import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  basename,
  dirname,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const MANIFEST_FILE = 'manifest.json';
const PAYLOAD_DIRECTORY = 'payload';
const MANIFEST_SCHEMA_VERSION = 1;
const DAEMON_ADMISSION_LOCK = '.geulbat/daemon-admission-lock.json';

export async function createStateMigrationBackup(options) {
  const stateRoot = await resolveExistingDirectoryRoot(
    options?.stateRoot,
    'state root',
  );
  const backupRoot = await resolveNewDirectoryRoot(
    options?.backupRoot,
    'backup root',
  );
  const targets = normalizeTargetPaths(options?.targetPaths);
  assertDisjointRoots(stateRoot, backupRoot, 'state root', 'backup root');
  await assertDaemonStopped(stateRoot, 'backup');
  await assertTargetAncestorsSafe(stateRoot, targets);

  const sourceEntries = await collectSelectedTree(stateRoot, targets);
  const manifest = createManifest(targets, sourceEntries);

  await mkdir(dirname(backupRoot), { recursive: true });
  await mkdir(backupRoot);
  const payloadRoot = join(backupRoot, PAYLOAD_DIRECTORY);
  await mkdir(payloadRoot);
  await copyManifestEntries(stateRoot, payloadRoot, sourceEntries);

  const copiedEntries = await collectSelectedTree(payloadRoot, targets);
  assertEntriesEqual(copiedEntries, sourceEntries, 'copied payload');
  await assertPayloadContainsOnlyTargets(payloadRoot, targets);

  const stableSourceEntries = await collectSelectedTree(stateRoot, targets);
  assertEntriesEqual(stableSourceEntries, sourceEntries, 'source tree');

  await writeFile(
    join(backupRoot, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );

  return verifyStateMigrationBackup({ backupRoot });
}

export async function verifyStateMigrationBackup(options) {
  const { manifest } = await loadVerifiedBackup(options?.backupRoot);
  return manifestSummary(manifest);
}

export async function measureStateMigrationBaseline(options) {
  const stateRoot = await resolveExistingDirectoryRoot(
    options?.stateRoot,
    'state root',
  );
  const targets = normalizeTargetPaths(options?.targetPaths);
  await assertDaemonStopped(stateRoot, 'baseline measurement');
  await assertTargetAncestorsSafe(stateRoot, targets);

  const initialEntries = await collectSelectedTree(stateRoot, targets);
  let jsonlEntryCount = 0;
  const jsonlEntries = initialEntries.filter(
    (entry) => entry.kind === 'file' && entry.path.endsWith('.jsonl'),
  );
  for (const entry of jsonlEntries) {
    jsonlEntryCount += await inspectStateMigrationFile(stateRoot, entry);
  }

  const stableEntries = await collectSelectedTree(stateRoot, targets);
  assertEntriesEqual(stableEntries, initialEntries, 'source tree');
  return {
    ...manifestSummary(createManifest(targets, initialEntries)),
    jsonlFileCount: jsonlEntries.length,
    jsonlEntryCount,
  };
}

export async function restoreStateMigrationBackup(options) {
  const { backupRoot, manifest } = await loadVerifiedBackup(
    options?.backupRoot,
  );
  const destinationStateRoot = await resolveDestinationDirectoryRoot(
    options?.destinationStateRoot,
  );
  assertDisjointRoots(
    backupRoot,
    destinationStateRoot,
    'backup root',
    'destination state root',
  );
  await assertDaemonStopped(destinationStateRoot, 'restore');
  await assertRestoreTargetsAbsent(destinationStateRoot, manifest.targets);

  await copyManifestEntries(
    join(backupRoot, PAYLOAD_DIRECTORY),
    destinationStateRoot,
    manifest.entries,
  );
  const restoredEntries = await collectSelectedTree(
    destinationStateRoot,
    manifest.targets,
  );
  assertEntriesEqual(restoredEntries, manifest.entries, 'restored tree');
  return manifestSummary(manifest);
}

async function loadVerifiedBackup(inputRoot) {
  const backupRoot = await resolveExistingDirectoryRoot(
    inputRoot,
    'backup root',
  );
  const rootEntries = await readdir(backupRoot, { withFileTypes: true });
  const rootEntryNames = rootEntries.map((entry) => entry.name).sort();
  if (
    rootEntryNames.length !== 2 ||
    rootEntryNames[0] !== MANIFEST_FILE ||
    rootEntryNames[1] !== PAYLOAD_DIRECTORY
  ) {
    throw new Error(
      'state migration backup refused: backup root contains unexpected entries',
    );
  }

  const manifestPath = join(backupRoot, MANIFEST_FILE);
  const payloadRoot = join(backupRoot, PAYLOAD_DIRECTORY);
  await assertRegularFile(manifestPath, 'backup manifest');
  await assertDirectory(payloadRoot, 'backup payload');
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  await assertTargetAncestorsSafe(payloadRoot, manifest.targets);
  const payloadEntries = await collectSelectedTree(
    payloadRoot,
    manifest.targets,
  );
  assertEntriesEqual(payloadEntries, manifest.entries, 'backup payload');
  await assertPayloadContainsOnlyTargets(payloadRoot, manifest.targets);
  return { backupRoot, manifest };
}

function createManifest(targets, entries) {
  const totals = summarizeEntries(entries);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    targets,
    entries,
    totals,
    treeSha256: hashJson({ targets, entries }),
  };
}

function parseManifest(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('state migration backup refused: invalid manifest JSON');
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'targets',
      'entries',
      'totals',
      'treeSha256',
    ]) ||
    value.schemaVersion !== MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error('state migration backup refused: invalid manifest header');
  }

  const targets = normalizeTargetPaths(value.targets);
  if (!Array.isArray(value.entries)) {
    throw new Error('state migration backup refused: invalid manifest entries');
  }
  const entries = value.entries.map(parseManifestEntry);
  assertSortedUniqueEntries(entries);
  assertEntriesCoveredByTargets(entries, targets);

  const totals = summarizeEntries(entries);
  if (
    !isRecord(value.totals) ||
    !hasOnlyKeys(value.totals, ['directoryCount', 'fileCount', 'byteLength']) ||
    value.totals.directoryCount !== totals.directoryCount ||
    value.totals.fileCount !== totals.fileCount ||
    value.totals.byteLength !== totals.byteLength
  ) {
    throw new Error('state migration backup refused: invalid manifest totals');
  }
  const expectedTreeSha256 = hashJson({ targets, entries });
  if (value.treeSha256 !== expectedTreeSha256) {
    throw new Error(
      'state migration backup refused: invalid manifest tree hash',
    );
  }
  return createManifest(targets, entries);
}

function parseManifestEntry(value) {
  if (!isRecord(value) || typeof value.path !== 'string') {
    throw new Error('state migration backup refused: invalid manifest entry');
  }
  const path = normalizePortableRelativePath(value.path, 'manifest entry');
  if (value.kind === 'directory' && hasOnlyKeys(value, ['kind', 'path'])) {
    return { kind: 'directory', path };
  }
  if (
    value.kind === 'file' &&
    hasOnlyKeys(value, ['kind', 'path', 'byteLength', 'sha256']) &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    return {
      kind: 'file',
      path,
      byteLength: value.byteLength,
      sha256: value.sha256,
    };
  }
  throw new Error('state migration backup refused: invalid manifest entry');
}

async function collectSelectedTree(root, targets) {
  const entries = [];
  for (const target of targets) {
    await collectTreeEntry(root, target, entries);
  }
  return entries.sort(compareEntries);
}

async function collectTreeEntry(root, portablePath, entries) {
  const absolutePath = joinPortablePath(root, portablePath);
  let entry;
  try {
    entry = await lstat(absolutePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        `state migration backup refused: target is missing: ${portablePath}`,
      );
    }
    throw error;
  }
  if (entry.isSymbolicLink()) {
    throw new Error(
      `state migration backup refused: symlink detected: ${portablePath}`,
    );
  }
  if (entry.isFile()) {
    entries.push({
      kind: 'file',
      path: portablePath,
      byteLength: entry.size,
      sha256: await hashFile(absolutePath),
    });
    return;
  }
  if (!entry.isDirectory()) {
    throw new Error(
      `state migration backup refused: unsupported entry: ${portablePath}`,
    );
  }

  entries.push({ kind: 'directory', path: portablePath });
  const children = await readdir(absolutePath, { withFileTypes: true });
  children.sort((left, right) => compareText(left.name, right.name));
  for (const child of children) {
    await collectTreeEntry(
      root,
      appendPortableChild(portablePath, child.name),
      entries,
    );
  }
}

async function copyManifestEntries(sourceRoot, destinationRoot, entries) {
  for (const entry of entries.filter(
    (candidate) => candidate.kind === 'directory',
  )) {
    await mkdir(joinPortablePath(destinationRoot, entry.path), {
      recursive: true,
    });
  }
  for (const entry of entries.filter(
    (candidate) => candidate.kind === 'file',
  )) {
    const destinationPath = joinPortablePath(destinationRoot, entry.path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(
      joinPortablePath(sourceRoot, entry.path),
      destinationPath,
      constants.COPYFILE_EXCL,
    );
  }
}

async function assertPayloadContainsOnlyTargets(payloadRoot, targets) {
  const entries = await listAllRelativePaths(payloadRoot);
  for (const entry of entries) {
    if (
      !targets.some(
        (target) =>
          isSameOrDescendant(target, entry.path) ||
          (entry.kind === 'directory' &&
            isSameOrDescendant(entry.path, target)),
      )
    ) {
      throw new Error(
        `state migration backup refused: unexpected payload entry: ${entry.path}`,
      );
    }
  }
}

async function listAllRelativePaths(root, portablePath = '') {
  const result = [];
  const directoryPath = portablePath
    ? joinPortablePath(root, portablePath)
    : root;
  const children = await readdir(directoryPath, { withFileTypes: true });
  children.sort((left, right) => compareText(left.name, right.name));
  for (const child of children) {
    const childPath = appendPortableChild(portablePath, child.name);
    const childStat = await lstat(joinPortablePath(root, childPath));
    if (childStat.isSymbolicLink()) {
      throw new Error(
        `state migration backup refused: symlink detected: ${childPath}`,
      );
    }
    if (childStat.isFile()) {
      result.push({ kind: 'file', path: childPath });
      continue;
    }
    if (!childStat.isDirectory()) {
      throw new Error(
        `state migration backup refused: unsupported entry: ${childPath}`,
      );
    }
    result.push({ kind: 'directory', path: childPath });
    result.push(...(await listAllRelativePaths(root, childPath)));
  }
  return result;
}

async function assertTargetAncestorsSafe(root, targets) {
  for (const target of targets) {
    const segments = target.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      const entry = await readOptionalEntry(joinPortablePath(root, ancestor));
      if (entry === null) {
        break;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `state migration backup refused: unsafe target ancestor: ${ancestor}`,
        );
      }
    }
  }
}

async function assertRestoreTargetsAbsent(root, targets) {
  await assertTargetAncestorsSafe(root, targets);
  for (const target of targets) {
    if ((await readOptionalEntry(joinPortablePath(root, target))) !== null) {
      throw new Error(
        `state migration restore refused: target already exists: ${target}`,
      );
    }
  }
}

async function assertDaemonStopped(root, operation) {
  if (
    (await readOptionalEntry(joinPortablePath(root, DAEMON_ADMISSION_LOCK))) !==
    null
  ) {
    throw new Error(
      `state migration ${operation} refused: stop the daemon and remove its admission lock first`,
    );
  }
}

function normalizeTargetPaths(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(
      'state migration backup refused: at least one explicit target is required',
    );
  }
  const targets = values
    .map((value) => normalizePortableRelativePath(value, 'target'))
    .sort(compareText);
  if (new Set(targets).size !== targets.length) {
    throw new Error('state migration backup refused: duplicate target');
  }
  for (let index = 0; index < targets.length; index += 1) {
    for (let sibling = index + 1; sibling < targets.length; sibling += 1) {
      if (isSameOrDescendant(targets[index], targets[sibling])) {
        throw new Error('state migration backup refused: overlapping targets');
      }
    }
  }
  return targets;
}

function normalizePortableRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`state migration backup refused: invalid ${label} path`);
  }
  if (win32.isAbsolute(value)) {
    throw new Error(`state migration backup refused: absolute ${label} path`);
  }
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (
    posix.isAbsolute(normalized) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`state migration backup refused: unsafe ${label} path`);
  }
  return normalized;
}

async function resolveExistingDirectoryRoot(value, label) {
  const root = normalizeRoot(value, label);
  await assertDirectory(root, label);
  return realpath(root);
}

async function resolveNewDirectoryRoot(value, label) {
  const canonicalRoot = await resolveProspectiveRoot(value, label);
  if ((await readOptionalEntry(canonicalRoot)) !== null) {
    throw new Error(`state migration backup refused: ${label} already exists`);
  }
  return canonicalRoot;
}

async function resolveDestinationDirectoryRoot(value) {
  const root = await resolveProspectiveRoot(value, 'destination state root');
  const existing = await readOptionalEntry(root);
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(
        'state migration restore refused: destination state root is not a safe directory',
      );
    }
    return realpath(root);
  }
  return root;
}

async function resolveProspectiveRoot(value, label) {
  const root = normalizeRoot(value, label);
  const missingSegments = [];
  let existingAncestor = root;
  while ((await readOptionalEntry(existingAncestor)) === null) {
    missingSegments.unshift(basename(existingAncestor));
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(
        `state migration backup refused: ${label} has no existing parent`,
      );
    }
    existingAncestor = parent;
  }
  const canonicalAncestor = await realpath(existingAncestor);
  await assertDirectory(canonicalAncestor, `${label} parent`);
  return join(canonicalAncestor, ...missingSegments);
}

function normalizeRoot(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`state migration backup refused: ${label} is required`);
  }
  const root = resolve(value);
  if (root === parse(root).root) {
    throw new Error(
      `state migration backup refused: ${label} cannot be a filesystem root`,
    );
  }
  return root;
}

function assertDisjointRoots(left, right, leftLabel, rightLabel) {
  if (isSameOrNestedRoot(left, right) || isSameOrNestedRoot(right, left)) {
    throw new Error(
      `state migration backup refused: ${leftLabel} and ${rightLabel} must be disjoint`,
    );
  }
}

function isSameOrNestedRoot(parent, candidate) {
  const result = relative(parent, candidate);
  return result === '' || (!result.startsWith(`..${sep}`) && result !== '..');
}

function assertEntriesEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`state migration backup refused: ${label} changed`);
  }
}

function assertSortedUniqueEntries(entries) {
  const sorted = [...entries].sort(compareEntries);
  if (JSON.stringify(entries) !== JSON.stringify(sorted)) {
    throw new Error(
      'state migration backup refused: manifest entries are not sorted',
    );
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('state migration backup refused: duplicate manifest entry');
  }
}

function assertEntriesCoveredByTargets(entries, targets) {
  for (const target of targets) {
    if (!entries.some((entry) => entry.path === target)) {
      throw new Error(
        'state migration backup refused: manifest target is missing',
      );
    }
  }
  if (
    entries.some(
      (entry) =>
        !targets.some((target) => isSameOrDescendant(target, entry.path)),
    )
  ) {
    throw new Error(
      'state migration backup refused: manifest entry escaped targets',
    );
  }
}

function summarizeEntries(entries) {
  return {
    directoryCount: entries.filter((entry) => entry.kind === 'directory')
      .length,
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    byteLength: entries.reduce(
      (total, entry) => total + (entry.kind === 'file' ? entry.byteLength : 0),
      0,
    ),
  };
}

function manifestSummary(manifest) {
  return {
    targets: [...manifest.targets],
    ...manifest.totals,
    treeSha256: manifest.treeSha256,
  };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function inspectStateMigrationFile(root, entry) {
  const input = createReadStream(joinPortablePath(root, entry.path), {
    encoding: 'utf8',
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let entryCount = 0;
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }
      try {
        JSON.parse(line);
      } catch {
        throw new Error(
          `state migration baseline refused: invalid JSONL record in ${entry.path} at line ${lineNumber}`,
        );
      }
      entryCount += 1;
    }
  } finally {
    lines.close();
  }
  return entryCount;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function joinPortablePath(root, portablePath) {
  return join(root, ...portablePath.split('/'));
}

function appendPortableChild(parent, childName) {
  if (childName.includes('\\')) {
    throw new Error(
      `state migration backup refused: path is not portable: ${childName}`,
    );
  }
  return parent ? `${parent}/${childName}` : childName;
}

function compareEntries(left, right) {
  return compareText(left.path, right.path);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSameOrDescendant(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

async function assertDirectory(path, label) {
  const entry = await readOptionalEntry(path);
  if (entry === null || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(
      `state migration backup refused: ${label} is not a safe directory`,
    );
  }
}

async function assertRegularFile(path, label) {
  const entry = await readOptionalEntry(path);
  if (entry === null || entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(
      `state migration backup refused: ${label} is not a safe file`,
    );
  }
}

async function readOptionalEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function isNotFoundError(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT',
  );
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function readCliOptions(argv) {
  const options = { measureOnly: false, targetPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--measure-only') {
      options.measureOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === '--state-root') {
      options.stateRoot = value;
    } else if (flag === '--backup-root') {
      options.backupRoot = value;
    } else if (flag === '--restore-root') {
      options.destinationStateRoot = value;
    } else if (flag === '--target') {
      options.targetPaths.push(value);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
    index += 1;
  }
  return options;
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  if (options.measureOnly) {
    if (options.backupRoot || options.destinationStateRoot) {
      throw new Error(
        '--measure-only cannot be combined with backup or restore roots',
      );
    }
    const baseline = await measureStateMigrationBaseline(options);
    process.stdout.write(`${JSON.stringify({ baseline }, null, 2)}\n`);
    return;
  }
  const backup = await createStateMigrationBackup(options);
  const verified = await verifyStateMigrationBackup(options);
  const restored = await restoreStateMigrationBackup(options);
  process.stdout.write(
    `${JSON.stringify({ backup, verified, restored }, null, 2)}\n`,
  );
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
