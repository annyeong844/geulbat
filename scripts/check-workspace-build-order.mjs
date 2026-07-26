#!/usr/bin/env node
/**
 * 워크스페이스 빌드 순서 검사.
 *
 * 모든 워크스페이스의 package.json `exports`는 소스가 아니라 `dist`의 `.d.ts`를
 * 가리킨다. 그래서 A가 B를 import하면 A를 타입 검사하기 **전에** B가 실제로
 * 빌드되어 있어야 한다. `tsc --noEmit`은 dist를 만들지 않으므로 `check:app`만
 * 도는 워크스페이스는 남의 공급자가 될 수 없다.
 *
 * 2026-07-25에 이 불변식이 조용히 깨졌다. geulbat-lab을 별도 워크스페이스로
 * 분리하면서 루트 `check`에 lab 검사를 추가했지만 geulbat은 `check:app` 그대로
 * 두었다. 로컬에는 예전 빌드의 dist가 남아 있어 통과했고, dist가 없는 CI 신규
 * 체크아웃에서만 `TS2307 Cannot find module '@geulbat/product/...'`로 터졌다.
 * 사람이 늦게 발견하는 종류의 실패다 — 로컬에서는 재현되지 않기 때문이다.
 *
 * 검사하는 불변식은 하나다:
 *   다른 워크스페이스가 의존하는 워크스페이스는 루트 `check` 안에서 빌드되어야
 *   하고, 그 소비자가 검사되기 전에 빌드되어야 한다.
 *
 * 아무도 import하지 않는 leaf 워크스페이스는 `check:app`(noEmit)으로 충분하다.
 * 그 구분이 이 검사의 존재 이유다. 전부 빌드하라고 요구하면 leaf까지 산출물을
 * 남기게 되므로, 소비되는 것만 골라 요구한다.
 *
 * 의존 간선은 `dependencies`에서만 읽는다. 루트 `check`는 각 워크스페이스의
 * `tsconfig.app.json`(테스트 제외)만 컴파일하므로, 테스트에서만 쓰는
 * `devDependencies` 간선을 세면 실제로는 필요 없는 빌드를 요구하게 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

/** dist를 방출하는 스크립트. `build:app`, `build:packages` 등. */
const EMITTING_SCRIPT = /^build/u;
/** 타입만 보고 산출물을 남기지 않는 스크립트. */
const NON_EMITTING_SCRIPT = /^check:app$/u;
/** `tsc -b packages/x/tsconfig.json` 형태에서 워크스페이스 디렉터리를 얻는다. */
const TSCONFIG_ARGUMENT = /([\w./-]+)\/tsconfig[\w.]*\.json/gu;

function directoriesFromTsconfigArguments(script) {
  return [...script.matchAll(TSCONFIG_ARGUMENT)].map((match) => match[1]);
}

/**
 * 루트 `check` 스크립트를 순서 있는 단계 목록으로 바꾼다.
 * 각 단계는 그 단계가 빌드하는 디렉터리와 검사만 하는 디렉터리를 갖는다.
 */
export function parseCheckPipeline(scripts) {
  const checkScript = scripts.check;
  if (typeof checkScript !== 'string') {
    throw new Error('root package.json has no `check` script to inspect');
  }

  return checkScript.split(/\s*&&\s*/u).map((step) => {
    const tokens = step.trim().split(/\s+/u);
    if (tokens[0] !== 'npm' || tokens[1] !== 'run') {
      return { builds: [], checks: [] };
    }

    const scriptName = tokens[2] ?? '';
    const workspaceFlag = tokens.indexOf('-w');
    const workspace =
      workspaceFlag === -1 ? undefined : tokens[workspaceFlag + 1];

    if (workspace === undefined) {
      // `-w` 없는 집합 빌드는 대상이 스크립트 본문에 적혀 있다.
      const expanded = scripts[scriptName];
      if (EMITTING_SCRIPT.test(scriptName) && typeof expanded === 'string') {
        return {
          builds: directoriesFromTsconfigArguments(expanded),
          checks: [],
        };
      }
      return { builds: [], checks: [] };
    }

    if (EMITTING_SCRIPT.test(scriptName)) {
      return { builds: [workspace], checks: [] };
    }
    if (NON_EMITTING_SCRIPT.test(scriptName)) {
      return { builds: [], checks: [workspace] };
    }
    return { builds: [], checks: [] };
  });
}

/**
 * 소비되는 워크스페이스가 소비자보다 먼저 빌드되는지 확인한다.
 * `check`가 아예 다루지 않는 워크스페이스는 이 검사의 대상이 아니다.
 */
export function findWorkspaceBuildOrderViolations({ workspaces, steps }) {
  const workspaceByKey = new Map();
  for (const workspace of workspaces) {
    workspaceByKey.set(workspace.dir, workspace);
    workspaceByKey.set(workspace.name, workspace);
  }

  const builtAt = new Map();
  const compiledAt = new Map();
  const remember = (into, target, index) => {
    const workspace = workspaceByKey.get(target);
    if (workspace !== undefined && !into.has(workspace.dir)) {
      into.set(workspace.dir, index);
    }
  };

  steps.forEach((step, index) => {
    for (const target of step.builds) {
      remember(builtAt, target, index);
      remember(compiledAt, target, index);
    }
    for (const target of step.checks) {
      remember(compiledAt, target, index);
    }
  });

  const violations = [];
  for (const consumer of workspaces) {
    const consumerIndex = compiledAt.get(consumer.dir);
    if (consumerIndex === undefined) {
      continue;
    }
    for (const providerName of consumer.internalDependencies) {
      const provider = workspaceByKey.get(providerName);
      if (provider === undefined) {
        continue;
      }
      const providerIndex = builtAt.get(provider.dir);
      if (providerIndex === undefined) {
        violations.push({
          kind: 'not-built',
          provider: provider.dir,
          providerName,
          consumer: consumer.dir,
        });
        continue;
      }
      // 같은 단계는 어긋남이 아니다. `tsc -b`가 project reference로 내부 순서를
      // 스스로 잡는다.
      if (providerIndex > consumerIndex) {
        violations.push({
          kind: 'built-too-late',
          provider: provider.dir,
          providerName,
          consumer: consumer.dir,
        });
      }
    }
  }
  return violations;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectWorkspaceDirectories(rootDirectory, workspaceGlobs) {
  const directories = [];
  for (const glob of workspaceGlobs) {
    if (!glob.endsWith('/*')) {
      directories.push(glob);
      continue;
    }
    const prefix = glob.slice(0, -2);
    const parent = path.join(rootDirectory, prefix);
    if (!fs.existsSync(parent)) {
      continue;
    }
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = `${prefix}/${entry.name}`;
      if (fs.existsSync(path.join(rootDirectory, directory, 'package.json'))) {
        directories.push(directory);
      }
    }
  }
  return directories;
}

function collectWorkspaces(rootDirectory, rootManifest) {
  const entries = collectWorkspaceDirectories(
    rootDirectory,
    rootManifest.workspaces ?? [],
  ).map((dir) => ({
    dir,
    manifest: readJson(path.join(rootDirectory, dir, 'package.json')),
  }));

  const workspaceNames = new Set(entries.map((entry) => entry.manifest.name));
  return entries.map(({ dir, manifest }) => ({
    dir,
    name: manifest.name,
    internalDependencies: Object.keys(manifest.dependencies ?? {}).filter(
      (dependency) => workspaceNames.has(dependency),
    ),
  }));
}

function main() {
  const rootManifest = readJson(path.join(REPO_ROOT, 'package.json'));
  const workspaces = collectWorkspaces(REPO_ROOT, rootManifest);
  const steps = parseCheckPipeline(rootManifest.scripts ?? {});
  const violations = findWorkspaceBuildOrderViolations({ workspaces, steps });

  if (violations.length === 0) {
    const consumed = new Set(
      workspaces.flatMap((workspace) => workspace.internalDependencies),
    );
    console.log(
      `workspace build order check passed (${workspaces.length} workspaces, ${consumed.size} consumed by another workspace)`,
    );
    return;
  }

  console.error(
    `workspace build order check failed (${violations.length} violation${violations.length === 1 ? '' : 's'})`,
  );
  for (const violation of violations) {
    if (violation.kind === 'not-built') {
      console.error(
        `${violation.consumer} depends on ${violation.providerName}, but \`check\` never builds ${violation.provider}`,
      );
    } else {
      console.error(
        `${violation.consumer} is checked before ${violation.provider} is built`,
      );
    }
    console.error(
      `  fix:   root \`check\` must run \`build:app -w ${violation.provider}\` before ${violation.consumer}`,
    );
  }
  console.error(
    '\n`exports`가 dist의 .d.ts를 가리키므로 `tsc --noEmit`만 돈 워크스페이스는',
  );
  console.error(
    '소비자가 해석할 수 없다. 로컬에 남은 dist가 이를 가려서, dist가 없는 CI',
  );
  console.error('신규 체크아웃에서만 터진다.');
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
