import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const outputDirName = process.argv[2];

if (!outputDirName) {
  throw new Error('usage: node ./scripts/sync-package-imports.mjs <dist-dir>');
}

const packageJsonPath = path.join(packageRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const sourceImports = packageJson.imports ?? {};

const runtimeImports = Object.fromEntries(
  Object.entries(sourceImports).map(([key, value]) => [
    key,
    rewriteImportTarget(value),
  ]),
);

const outputDir = path.join(packageRoot, outputDirName);
await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, 'package.json'),
  `${JSON.stringify({ type: packageJson.type, imports: runtimeImports }, null, 2)}\n`,
);

function rewriteImportTarget(value) {
  if (typeof value === 'string') {
    return rewriteImportPath(value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        rewriteImportTarget(nested),
      ]),
    );
  }
  throw new Error(`unsupported import target: ${JSON.stringify(value)}`);
}

function rewriteImportPath(specifier) {
  if (!specifier.startsWith('./src/')) {
    throw new Error(`expected ./src/ import target, got: ${specifier}`);
  }
  return `./${specifier.slice('./src/'.length).replace(/\.tsx?$/, '.js')}`;
}
