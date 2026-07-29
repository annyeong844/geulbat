import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const TOOL_SDK_RELEASE_MANIFEST_FILENAME =
  'tool-sdk-release-manifest-v1.json';
export const TOOL_SDK_RELEASE_CHECKSUMS_FILENAME = 'SHA256SUMS';
export const TOOL_SDK_RELEASE_CONSUMER_FILENAME =
  'external-tool-sdk-daemon-consumer.mjs';
export const TOOL_SDK_RELEASE_CHANNEL = 'public-github-release-attested-bundle';
export const TOOL_SDK_RELEASE_QUALIFIED_NODE_MAJORS = Object.freeze([24, 26]);

export function assertToolSdkReleaseTag(releaseTag, toolSdkVersion) {
  const expected = `tool-sdk-v${toolSdkVersion}`;
  if (releaseTag !== expected) {
    throw new Error(
      `Tool SDK release tag must match package version: expected ${expected}, received ${releaseTag}`,
    );
  }
}

export async function verifyReproduciblePackedPackages(options) {
  for (const workspace of options.packageWorkspaces) {
    const expected = readPackageInfo(
      options.expectedPackageInfos,
      workspace.name,
    );
    const actual = readPackageInfo(options.actualPackageInfos, workspace.name);
    if (actual.filename !== expected.filename) {
      throw new Error(
        `${workspace.name} reproducible pack filename mismatch: ${expected.filename} != ${actual.filename}`,
      );
    }
    const [expectedDigest, actualDigest] = await Promise.all([
      sha256File(path.join(options.expectedPackDir, expected.filename)),
      sha256File(path.join(options.actualPackDir, actual.filename)),
    ]);
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `${workspace.name} reproducible pack digest mismatch: ${expectedDigest} != ${actualDigest}`,
      );
    }
  }
}

export async function createToolSdkReleaseManifest(options) {
  const packages = [];
  let nodeEngines;

  for (const workspace of options.packageWorkspaces) {
    const packageInfo = readPackageInfo(options.packageInfos, workspace.name);
    assertPortableFilename(packageInfo.filename);
    const manifest = JSON.parse(
      await readFile(
        path.join(options.repoRoot, workspace.manifestPath),
        'utf8',
      ),
    );
    const tarballPath = path.join(options.packDir, packageInfo.filename);
    const fileStat = await stat(tarballPath);
    if (!fileStat.isFile()) {
      throw new Error(
        `${workspace.name} release artifact is not a regular file: ${packageInfo.filename}`,
      );
    }
    if (workspace.name === '@geulbat/tool-sdk') {
      nodeEngines = manifest.engines?.node;
    }
    packages.push({
      filename: packageInfo.filename,
      name: workspace.name,
      releaseRole: readReleaseRole(workspace.name),
      sha256: await sha256File(tarballPath),
      size: fileStat.size,
      version: readManifestVersion(manifest, workspace.name),
    });
  }

  if (typeof nodeEngines !== 'string' || nodeEngines.length === 0) {
    throw new Error('Tool SDK release manifest requires a Node engines range');
  }

  const consumerSourcePath = path.join(
    options.repoRoot,
    'scripts',
    TOOL_SDK_RELEASE_CONSUMER_FILENAME,
  );
  const consumerStat = await stat(consumerSourcePath);
  if (!consumerStat.isFile()) {
    throw new Error(
      `Tool SDK conformance consumer is not a regular file: ${TOOL_SDK_RELEASE_CONSUMER_FILENAME}`,
    );
  }

  return {
    schemaVersion: 1,
    releaseChannel: TOOL_SDK_RELEASE_CHANNEL,
    conformanceConsumer: {
      filename: TOOL_SDK_RELEASE_CONSUMER_FILENAME,
      sha256: await sha256File(consumerSourcePath),
      size: consumerStat.size,
    },
    node: {
      engines: nodeEngines,
      qualifiedMajors: [...TOOL_SDK_RELEASE_QUALIFIED_NODE_MAJORS],
    },
    packages,
  };
}

export async function createToolSdkReleaseBundle(options) {
  const outputDir = path.resolve(options.outputDir);
  const outputParent = path.dirname(outputDir);
  const outputName = path.basename(outputDir);
  if (outputName.length === 0 || outputDir === path.parse(outputDir).root) {
    throw new Error('Tool SDK release output must name a dedicated directory');
  }
  await assertPathMissing(outputDir);

  await mkdir(outputParent, { recursive: true });
  const stagingDir = await mkdtemp(
    path.join(outputParent, `.${outputName}-staging-`),
  );

  try {
    const manifest = await createToolSdkReleaseManifest(options);
    for (const packageEntry of manifest.packages) {
      await copyFile(
        path.join(options.packDir, packageEntry.filename),
        path.join(stagingDir, packageEntry.filename),
      );
    }
    await copyFile(
      path.join(
        options.repoRoot,
        'scripts',
        TOOL_SDK_RELEASE_CONSUMER_FILENAME,
      ),
      path.join(stagingDir, TOOL_SDK_RELEASE_CONSUMER_FILENAME),
    );

    const manifestPath = path.join(
      stagingDir,
      TOOL_SDK_RELEASE_MANIFEST_FILENAME,
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const manifestDigest = await sha256File(manifestPath);
    const checksumEntries = [
      ...manifest.packages.map(({ filename, sha256 }) => ({
        filename,
        sha256,
      })),
      {
        filename: TOOL_SDK_RELEASE_MANIFEST_FILENAME,
        sha256: manifestDigest,
      },
      manifest.conformanceConsumer,
    ].sort(compareFilenames);
    for (const { filename, sha256 } of checksumEntries) {
      const stagedDigest = await sha256File(path.join(stagingDir, filename));
      if (stagedDigest !== sha256) {
        throw new Error(
          `Tool SDK staged release digest mismatch for ${filename}: ${sha256} != ${stagedDigest}`,
        );
      }
    }
    await writeFile(
      path.join(stagingDir, TOOL_SDK_RELEASE_CHECKSUMS_FILENAME),
      checksumEntries
        .map(({ filename, sha256 }) => `${sha256}  ${filename}\n`)
        .join(''),
      { encoding: 'utf8', flag: 'wx' },
    );
    await rename(stagingDir, outputDir);
    return {
      checksumsPath: path.join(outputDir, TOOL_SDK_RELEASE_CHECKSUMS_FILENAME),
      manifest,
      outputDir,
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function readPackageInfo(packageInfos, packageName) {
  const packageInfo = packageInfos.find(
    (candidate) => candidate.name === packageName,
  );
  if (
    packageInfo === undefined ||
    typeof packageInfo.filename !== 'string' ||
    packageInfo.filename.length === 0
  ) {
    throw new Error(`npm pack output is missing ${packageName}`);
  }
  return packageInfo;
}

function assertPortableFilename(filename) {
  if (
    path.basename(filename) !== filename ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new Error(`npm pack returned a non-portable filename: ${filename}`);
  }
}

function compareFilenames(left, right) {
  if (left.filename < right.filename) {
    return -1;
  }
  if (left.filename > right.filename) {
    return 1;
  }
  return 0;
}

async function assertPathMissing(outputDir) {
  try {
    await lstat(outputDir);
  } catch (error) {
    if (isFileSystemError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`Tool SDK release output already exists: ${outputDir}`);
}

function isFileSystemError(error) {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function readManifestVersion(manifest, packageName) {
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${packageName} manifest is missing a version`);
  }
  return manifest.version;
}

function readReleaseRole(packageName) {
  if (packageName === '@geulbat/tool-sdk') {
    return 'public-sdk';
  }
  if (packageName === '@geulbat/daemon') {
    return 'embedding-host';
  }
  return 'runtime-dependency';
}
