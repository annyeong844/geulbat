#!/usr/bin/env node

import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

export const DEFAULT_PUBLIC_CI_MIRROR_INCLUDE_PATHS = [
  '.github/workflows',
  '.oxfmtrc.json',
  '.prettierrc.json',
  '.rustlike/provider.mjs',
  'eslint.config.js',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'release/provider-auth-approved-client-ids.json',
  'scripts/build-ptc-session-image.mjs',
  'scripts/check-npm-installable-distribution.mjs',
  'scripts/check-provider-auth-release-artifact.mjs',
  'scripts/check-workspace-build-order.mjs',
  'scripts/dev-daemon-port.mjs',
  'scripts/evaluate-agent-autonomy.mjs',
  'scripts/evaluate-agent-autonomy.test.mjs',
  'scripts/export-public-ci-mirror.mjs',
  'scripts/external-tool-sdk-daemon-consumer.mjs',
  'scripts/node-test-lanes.mjs',
  'scripts/npm-installable-distribution-validation.mjs',
  'scripts/owned-child-process.mjs',
  'scripts/owned-child-process.test.mjs',
  'scripts/performance-report-support.mjs',
  'scripts/provider-auth-release-validation.mjs',
  'scripts/run-eslint-shards.mjs',
  'scripts/run-node-tests-fail-fast.mjs',
  'scripts/run-workspace-node-tests.mjs',
  'scripts/tool-sdk-release-bundle.mjs',
  'apps/daemon/package.json',
  'apps/daemon/creator-plugin',
  'apps/daemon/docker/ptc-session',
  'apps/daemon/provider-auth.config.example.json',
  'apps/daemon/provider-auth.config.json',
  'apps/daemon/scripts',
  'apps/daemon/src',
  'apps/daemon/tsconfig.app.json',
  'apps/daemon/tsconfig.json',
  'apps/daemon/tsconfig.test.json',
  'apps/geulbat/package.json',
  'apps/geulbat/scripts',
  'apps/geulbat/src',
  'apps/geulbat/tsconfig.app.json',
  'apps/geulbat/tsconfig.json',
  'apps/geulbat/tsconfig.test.json',
  'apps/geulbat-lab/package.json',
  'apps/geulbat-lab/src',
  'apps/geulbat-lab/tsconfig.app.json',
  'apps/geulbat-lab/tsconfig.json',
  'apps/geulbat-lab/tsconfig.test.json',
  'apps/web-shell/index.html',
  'apps/web-shell/package.json',
  'apps/web-shell/public',
  'apps/web-shell/scripts',
  'apps/web-shell/src',
  'apps/web-shell/tsconfig.app.json',
  'apps/web-shell/tsconfig.json',
  'apps/web-shell/tsconfig.node.json',
  'apps/web-shell/tsconfig.test.json',
  'apps/web-shell/vite.config.ts',
  'packages/agent-loop/package.json',
  'packages/agent-loop/src',
  'packages/agent-loop/tsconfig.json',
  'packages/agent-loop/tsconfig.test.json',
  'packages/xharness/package.json',
  'packages/xharness/src',
  'packages/xharness/tsconfig.json',
  'packages/xharness/tsconfig.test.json',
  'packages/artifact-runtime-policy/package.json',
  'packages/artifact-runtime-policy/src',
  'packages/artifact-runtime-policy/tsconfig.json',
  'packages/artifact-runtime-policy/tsconfig.test.json',
  'packages/content-identity/package.json',
  'packages/content-identity/src',
  'packages/content-identity/tsconfig.json',
  'packages/content-identity/tsconfig.test.json',
  'packages/daemon-lifecycle/package.json',
  'packages/daemon-lifecycle/src',
  'packages/daemon-lifecycle/tsconfig.json',
  'packages/daemon-lifecycle/tsconfig.test.json',
  'packages/protocol/package.json',
  'packages/protocol/src',
  'packages/protocol/tsconfig.json',
  'packages/protocol/tsconfig.test.json',
  'packages/structured-logger/package.json',
  'packages/structured-logger/src',
  'packages/structured-logger/tsconfig.json',
  'packages/structured-logger/tsconfig.test.json',
  'packages/tool-library/package.json',
  'packages/tool-library/src',
  'packages/tool-library/tsconfig.json',
  'packages/tool-library/tsconfig.test.json',
  'packages/tool-sdk/package.json',
  'packages/tool-sdk/src',
  'packages/tool-sdk/tsconfig.json',
  'packages/tool-sdk/tsconfig.test.json',
];

const GENERATED_PUBLIC_FILES = new Map([
  [
    'README.md',
    [
      '# Geulbat',
      '',
      'This repository is a sanitized, runnable public snapshot of Geulbat generated from private/local source.',
      '',
      'The source is available under the MIT License. See `LICENSE`.',
      '',
      '## Prerequisites',
      '',
      '- Node.js 24 or newer',
      '- npm',
      '',
      '## Install and verify',
      '',
      '```bash',
      'npm ci',
      'npm run check',
      'npm run build',
      '```',
      '',
      '## Run locally',
      '',
      'Start the daemon and web shell in separate terminals:',
      '',
      '```bash',
      'npm run dev:daemon',
      '```',
      '',
      '```bash',
      'npm run dev -w apps/web-shell',
      '```',
      '',
      'Provider credentials and tokens are not included. Complete provider sign-in on your own machine; runtime credentials remain local to that machine.',
      '',
      'This public repository keeps only `main` and is not the development source of truth. Fixes happen in the private/local source and are exported again as a sanitized snapshot.',
      '',
    ].join('\n'),
  ],
  [
    'AGENTS.md',
    [
      '# Geulbat Public Repository Working Rules',
      '',
      '## Repository role',
      '',
      '- This is a generated, sanitized, runnable public snapshot licensed under MIT.',
      '- The public remote keeps only the `main` branch.',
      '- Private/local source remains the development, review, and merge source of truth.',
      '- Fixes flow one way: private/local source -> sanitized export -> public `main`.',
      '- Never add credentials, personal data, private history, private audit output, or local-machine paths.',
      '',
      '## Environment and startup',
      '',
      '- Use Node.js 24 or newer and install from the lockfile with `npm ci`.',
      '- Start `npm run dev:daemon` and `npm run dev -w apps/web-shell` in separate terminals.',
      '- Provider credentials are supplied by each user and remain local to that machine.',
      '',
      '## Change workflow',
      '',
      '1. Inspect current code, tests, static imports, and the relevant current-truth document before changing behavior.',
      '2. Keep changes scoped to one coherent capability or bug fix; keep its code, tests, and current-truth documentation together.',
      '3. Prefer real store, file, route, process, and integration boundaries. Use mocks only when the real boundary cannot prove the contract.',
      '4. Do not hide canonical-path failures with silent fallback, weaken tests to make them pass, or introduce unexplained product limits.',
      '5. Reuse existing owners and import seams before adding helpers, wrappers, files, or aliases.',
      '',
      '## Required verification',
      '',
      'For source, config, test, or generated-runtime changes:',
      '',
      '1. `npm run format:check`',
      '2. `npm run lint`',
      '3. Run every affected workspace check:',
      '   - `npm run check -w apps/daemon`',
      '   - `npm run check -w apps/geulbat`',
      '   - `npm run check -w apps/web-shell`',
      '   - `npm run check -w packages/agent-loop`',
      '   - `npm run check -w packages/xharness`',
      '   - `npm run check -w packages/artifact-runtime-policy`',
      '   - `npm run check -w packages/content-identity`',
      '   - `npm run check -w packages/protocol`',
      '4. Run focused behavior tests with `GEULBAT_TEST_JOBS=1` where the test runner supports it.',
      '5. Run `git diff --check -- <changed-files...>`.',
      '',
      'For Markdown-only changes, run Oxfmt on the changed documents, `npm run check:docs-current-truth` when current-truth documents change, and `git diff --check` on those files.',
      '',
      'Run one heavy verification command at a time and wait for its real exit code. A timeout or interrupted command is not a pass.',
      '',
      '## Formatting and generated files',
      '',
      '- Oxfmt is canonical for code, config, and docs. Prettier is canonical only for `package-lock.json`.',
      '- Apply formatter writes only to explicit changed files; do not run a repository-wide auto-fix.',
      '- When web-shell artifact runtime sources change, run `npm run sync:artifact-runtime-sources -w apps/web-shell` and then the web-shell check.',
      '',
      '## Git and publishing safety',
      '',
      '- Preserve existing dirty work. Stage explicit paths; do not use `git add -A`, destructive reset/clean, or force-push.',
      '- Keep commits coherent and reviewable. Do not split code from the tests and current-truth updates that prove it.',
      '- Publish only a sanitized, verified snapshot to public `main` with a normal fast-forward update.',
      '- Do not publish temporary export branches or reverse-merge public mirror commits into the source repository.',
      '',
    ].join('\n'),
  ],
  [
    '.gitignore',
    [
      'node_modules/',
      'dist/',
      'dist-dev/',
      'dist-node/',
      'dist-test/',
      'dist-test-cache/',
      'dist-test-cache.lock*',
      'dist-test-run-*/',
      'coverage/',
      'playwright-report/',
      'test-results/',
      '*.tsbuildinfo',
      '.eslintcache*',
      '',
      '.env',
      '.env.*',
      '!.env.example',
      '!apps/daemon/.env.example',
      '',
      '.DS_Store',
      'Thumbs.db',
      '',
      '.geulbat/',
      '.playwright-cli/',
      'runtime-artifacts/',
      '.audit*/',
      'audit-output/',
      'evaluation/',
      '*.log',
      '',
      'workspace/*',
      '!workspace/.gitkeep',
      'apps/daemon/workspace/',
      '',
    ].join('\n'),
  ],
  ['workspace/.gitkeep', ''],
  [
    'scripts/check-doc-current-truth-public-mirror.mjs',
    [
      '#!/usr/bin/env node',
      '',
      "import { constants } from 'node:fs';",
      "import { access } from 'node:fs/promises';",
      "import path from 'node:path';",
      "import process from 'node:process';",
      '',
      'const PRIVATE_DOC_PATHS = [',
      "  'docs/current/spec/phase5',",
      "  'docs/current/spec/phase7-shell-redesign',",
      "  'docs/current/audit',",
      '];',
      '',
      'for (const relativePath of PRIVATE_DOC_PATHS) {',
      '  if (await pathExists(path.resolve(process.cwd(), relativePath))) {',
      '    throw new Error(',
      '      `public mirror must not export private docs path: ${relativePath}`,',
      '    );',
      '  }',
      '}',
      '',
      "console.log('public mirror docs profile check passed (private docs omitted)');",
      '',
      'async function pathExists(filePath) {',
      '  try {',
      '    await access(filePath, constants.F_OK);',
      '    return true;',
      '  } catch {',
      '    return false;',
      '  }',
      '}',
      '',
    ].join('\n'),
  ],
]);

const PUBLIC_TEXT_REPLACEMENTS = [
  { pattern: /\bsuyeon\b/g, replacement: 'sample' },
  { pattern: /\bSuyeon\b/g, replacement: 'Sample' },
  { pattern: /\bendof\b/g, replacement: 'user' },
  { pattern: /\bEndof\b/g, replacement: 'User' },
];

const FORBIDDEN_FILE_BASENAMES = new Set(['.npmrc']);
const FORBIDDEN_FILE_EXACT = new Set([
  '.git',
  '.env',
  '.env.local',
  'provider.json',
]);
const FORBIDDEN_DIRECTORY_NAMES = new Set([
  '.git',
  'audit-output',
  'evaluation',
  'runtime-artifacts',
]);
const SOURCE_RECURSION_EXCLUDED_DIRECTORY_NAMES = new Set([
  '.audit',
  'audit-output',
  'evaluation',
  'runtime-artifacts',
]);

const CONTENT_PATTERNS = [
  {
    code: 'forbidden_local_path',
    pattern: /C:\\+Users\\+[^ \n"'`]+/g,
    reason: 'Windows user home path',
  },
  {
    code: 'forbidden_local_path',
    pattern: /\/mnt\/c\/Users\/[^ \n"'`]+/g,
    reason: 'WSL Windows user home path',
  },
  {
    code: 'forbidden_local_path',
    pattern: /file:\/\/\/[^ \n"'`<>)]+/g,
    reason: 'local file URL',
  },
  {
    code: 'forbidden_private_home_path',
    pattern: /(^|[\s"'=])\/home\/(?!runner(?:\/|$))[^/\s"'`]+/g,
    reason: 'private Linux home path',
  },
  {
    code: 'forbidden_private_home_path',
    pattern: /(^|[\s"'=])\/Users\/(?!runner(?:\/|$))[^/\s"'`]+/g,
    reason: 'private macOS home path',
  },
  {
    code: 'forbidden_private_registry_reference',
    pattern: /npm\.pkg\.github\.com/g,
    reason: 'private GitHub package registry reference',
  },
  {
    code: 'forbidden_private_repository_transport',
    pattern: /git@github\.com:|git\+ssh:\/\//g,
    reason: 'private SSH repository transport reference',
  },
  {
    code: 'forbidden_private_key_marker',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    reason: 'private key marker',
  },
  {
    code: 'forbidden_api_key_value',
    pattern:
      /\b(?:[A-Z0-9_]+_API_KEY|GH_TOKEN|GITHUB_TOKEN)\b\s*[:=]\s*["']?(?!<|YOUR_|REPLACE_|placeholder|example)([A-Za-z0-9._~+/=-]{8,})/g,
    reason: 'token-shaped API key assignment',
  },
  {
    code: 'forbidden_secret_token_value',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?!test-|example|placeholder)(?:proj-[A-Za-z0-9_-]{20,}|ant-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{32,}))\b/g,
    reason: 'token-shaped secret value',
  },
  {
    code: 'forbidden_aws_secret_access_key_value',
    pattern:
      /\bAWS_SECRET_ACCESS_KEY\b\s*[:=]\s*["']?(?!<|YOUR_|REPLACE_|placeholder|example|test)([A-Za-z0-9/+=]{40})["']?/g,
    reason: 'AWS secret access key assignment',
  },
  {
    code: 'forbidden_database_password_value',
    pattern:
      /\bDATABASE_PASSWORD\b\s*[:=]\s*["']?(?!<|YOUR_|REPLACE_|placeholder|example|test|secret\b)([A-Za-z0-9._~+/=-]{12,})["']?/gi,
    reason: 'database password assignment',
  },
  {
    code: 'forbidden_credential_value',
    pattern:
      /\b(?:accessToken|refreshToken|clientSecret|client_secret)\b\s*[:=]\s*["']([A-Za-z0-9._~+/=-]{32,})["']/g,
    reason: 'token-shaped provider credential assignment',
  },
  {
    code: 'forbidden_provider_auth_file_path',
    pattern:
      /\bGEULBAT_PROVIDER_AUTH_FILE_PATH\b\s*[:=]\s*["']?(?:C:\\|\/mnt\/c\/|\/Users\/|\/home\/(?!runner(?:\/|$)))/g,
    reason: 'provider auth credential path override',
  },
];

const PUBLIC_OUTPUT_CONTENT_PATTERNS = [
  {
    code: 'forbidden_public_personal_marker',
    pattern: /\bsuyeon\b/gi,
    reason: 'private personal name marker',
  },
  {
    code: 'forbidden_public_personal_marker',
    pattern: /\bendof\b/gi,
    reason: 'private local account marker',
  },
];

const PUBLIC_SAFE_FIXTURE_ALLOWLIST = [
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user\\r\\n',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user\\r\\n',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user\\\\Downloads\\\\repo\\r\\n',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user\\\\Downloads\\\\repo\\r\\n',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user\\\\Downloads\\\\repo',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: 'C:\\\\Users\\\\user\\\\Downloads\\\\repo',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: '/mnt/c/Users/user/Downloads/repo',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: '/mnt/c/Users/user/Downloads/repo',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: '/mnt/c/Users/user/Downloads/repo\\n',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: '/mnt/c/Users/user/Downloads/repo\\n',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: '/mnt/c/Users/user',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: '/mnt/c/Users/user',
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/computer-directory-picker.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/computer-file-scope.test.ts',
    value: "'/Users/Alice",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/computer-session-defaults.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/computer-session-defaults.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/computer-session-defaults.test.ts',
    value: "'/home/writer",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/computer-session-defaults.test.ts',
    value: "'/Users/writer",
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-session-defaults.test.ts',
    value: 'C:\\\\Users\\\\Writer\\\\Downloads',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/computer-session-defaults.test.ts',
    value: 'C:\\\\Users\\\\Writer\\\\OneDrive\\\\사진',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/normalize-path.test.ts',
    value: 'C:\\\\Users\\\\User\\\\Workspace',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/files/normalize-path.test.ts',
    value: 'C:\\\\Users\\\\User\\\\Workspace',
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/normalize-path.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/files/normalize-path.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-ripgrep.test.ts',
    value: 'C:\\\\Users\\\\user\\\\docs\\\\note.md',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-ripgrep.test.ts',
    value: 'C:\\\\Users\\\\user\\\\docs\\\\note.md',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-ripgrep.test.ts',
    value: '/mnt/c/Users/user',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-ripgrep.test.ts',
    value: '/mnt/c/Users/user',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-ripgrep.test.ts',
    value: '/mnt/c/Users/user/docs/note.md',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-ripgrep.test.ts',
    value: '/mnt/c/Users/user/docs/note.md',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-windows-index.test.ts',
    value: '/mnt/c/Users/user',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/search-files-windows-index.test.ts',
    value: '/mnt/c/Users/user',
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/tools/file-tool-root.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_private_home_path',
    path: 'apps/daemon/src/daemon/tools/file-tool-root.test.ts',
    value: "'/home/user",
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/html/validator.test.ts',
    value: 'file:///tmp/secret.png',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/react-bundle/validator.test.ts',
    value: 'file:///tmp/react-entry.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/assistant/runtime-frame/artifact-runtime-preview-adapter.test.ts',
    value: 'file:///etc/passwd',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/runtime-preview/renderer-dispatch.test.ts',
    value: 'file:///tmp/unsafe-preview.png',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/sandbox/react-bundle-accepted-runtime-manifest.test.ts',
    value: 'file:///tmp/app.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/sandbox/react-bundle-dependency-prepare.test.ts',
    value: 'file:///tmp/app.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/react-bundle-dependency-admission/react-bundle-accepted-runtime-manifest.test.ts',
    value: 'file:///tmp/app.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/react-bundle-dependency-admission/react-bundle-dependency-prepare.test.ts',
    value: 'file:///tmp/app.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/react-bundle/validator-runtime-dependencies.test.ts',
    value: 'file:///tmp/geulbat-runtime-dependency.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/react-bundle/validator-runtime-dependencies.test.ts',
    value: 'file:///tmp/geulbat-runtime-dependency.css',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/react-bundle/validator-runtime-dependencies.test.ts',
    value: 'file:///tmp/theme.css',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/runtime-preview/react-bundle/inline-compile-preview-model.test.ts',
    value: 'file:///tmp/geulbat-runtime-dependency.css',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/web-shell/src/features/artifacts/react-bundle/validator-url-policy.test.ts',
    value: 'file:///tmp/react-entry.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'packages/artifact-runtime-policy/src/react-bundle-url.test.ts',
    value: 'file:///tmp/react-entry.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/daemon/src/daemon/tools/builtin/web-fetch-url-guard.test.ts',
    value: 'file:///etc/passwd',
  },
  // Qwen Token Plan replacement test. The literal is a synthetic credential and
  // the two remaining matches assign `process.env` from a local variable rather
  // than from a token literal, which the API-key pattern cannot distinguish.
  {
    code: 'forbidden_api_key_value',
    path: 'apps/daemon/src/daemon/llm/provider/qwen/chat-completions-replacement.test.ts',
    value: "TEST_API_KEY = 'qwen-test-secret-credential-1234567890",
  },
  {
    code: 'forbidden_api_key_value',
    path: 'apps/daemon/src/daemon/llm/provider/qwen/chat-completions-replacement.test.ts',
    value: 'BAILIAN_TOKEN_PLAN_API_KEY = TEST_API_KEY',
  },
  {
    code: 'forbidden_api_key_value',
    path: 'apps/daemon/src/daemon/llm/provider/qwen/chat-completions-replacement.test.ts',
    value: 'BAILIAN_TOKEN_PLAN_API_KEY = previousApiKey',
  },
  // Synthetic container/repo module URLs, not local-machine paths.
  {
    code: 'forbidden_local_path',
    path: 'apps/geulbat/src/bundled-shell-assets.test.ts',
    value: 'file:///repo/apps/geulbat/dist/bundled-shell-assets.js',
  },
  {
    code: 'forbidden_local_path',
    path: 'apps/geulbat/src/bundled-shell-assets.test.ts',
    value:
      'file:///app/node_modules/@geulbat/product/dist/bundled-shell-assets.js',
  },
];

export function parseExportPublicCiMirrorArgs(input) {
  let sourceRoot = REPO_ROOT;
  let outputDir = null;
  let force = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    switch (current) {
      case '--source-root':
        sourceRoot = readOptionValue(current, next);
        index += 1;
        break;
      case '--output':
        outputDir = readOptionValue(current, next);
        index += 1;
        break;
      case '--force':
        force = true;
        break;
      case '--help':
        throw new Error(readUsage());
      default:
        throw new Error(`unknown argument: ${current}\n${readUsage()}`);
    }
  }

  if (!outputDir) {
    throw new Error(`--output is required\n${readUsage()}`);
  }

  return {
    force,
    outputDir,
    sourceRoot,
  };
}

export async function exportPublicCiMirror(options) {
  const sourceRoot = path.resolve(options.sourceRoot ?? REPO_ROOT);
  const outputDir = path.resolve(readRequiredString(options, 'outputDir'));
  const includePaths =
    options.includePaths ?? DEFAULT_PUBLIC_CI_MIRROR_INCLUDE_PATHS;

  if (isPathInside(outputDir, sourceRoot) || outputDir === sourceRoot) {
    throw new Error('public CI mirror output must be outside the source root');
  }

  const sourceFiles = await collectIncludedFiles(sourceRoot, includePaths);
  const sourceViolations = await collectPublicCiMirrorExportViolations(
    sourceRoot,
    { filePaths: sourceFiles },
  );
  if (sourceViolations.length > 0) {
    throw new Error(formatExportViolations(sourceViolations));
  }

  if ((await pathExists(outputDir)) && !options.force) {
    throw new Error(
      `public CI mirror output already exists; pass --force to replace it: ${outputDir}`,
    );
  }

  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  for (const relativePath of sourceFiles) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(outputDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyPublicMirrorFile(sourcePath, targetPath, relativePath);
  }

  await writePublicMirrorPackageManifest({ outputDir, sourceRoot });

  for (const [relativePath, contents] of GENERATED_PUBLIC_FILES) {
    const targetPath = path.join(outputDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contents, 'utf8');
  }

  const outputViolations = await collectPublicCiMirrorExportViolations(
    outputDir,
    {
      includePublicOutputPatterns: true,
    },
  );
  if (outputViolations.length > 0) {
    await rm(outputDir, { force: true, recursive: true });
    throw new Error(formatExportViolations(outputViolations));
  }

  return {
    copiedFileCount: sourceFiles.length + GENERATED_PUBLIC_FILES.size,
    outputDir,
  };
}

async function copyPublicMirrorFile(sourcePath, targetPath, relativePath) {
  const stats = await lstat(sourcePath);
  if (stats.isSymbolicLink()) {
    throw new Error(
      formatExportViolations([
        {
          code: 'forbidden_symlink',
          message: `public CI mirror export would copy a symlink: ${relativePath}`,
          path: relativePath,
        },
      ]),
    );
  }

  if (!(await isTextFile(sourcePath))) {
    await copyFile(sourcePath, targetPath);
    return;
  }

  const contents = await readFile(sourcePath, 'utf8');
  await writeFile(targetPath, applyPublicMirrorTextReplacements(contents));
}

function applyPublicMirrorTextReplacements(contents) {
  let sanitized = contents;
  for (const replacement of PUBLIC_TEXT_REPLACEMENTS) {
    sanitized = sanitized.replaceAll(
      replacement.pattern,
      replacement.replacement,
    );
  }
  return sanitized;
}

async function writePublicMirrorPackageManifest({ outputDir, sourceRoot }) {
  const sourceManifestPath = path.join(sourceRoot, 'package.json');
  const targetManifestPath = path.join(outputDir, 'package.json');
  const manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
  const hasTestScript = typeof manifest.scripts?.test === 'string';
  manifest.license = 'MIT';
  manifest.scripts = {
    ...manifest.scripts,
    'check:docs-current-truth':
      'node scripts/check-doc-current-truth-public-mirror.mjs',
  };
  if (hasTestScript) {
    manifest.scripts.test = [
      'npm run build:packages',
      'npm run test:packages',
      'npm run test:app -w apps/daemon',
      'npm run test:app -w apps/geulbat',
      'npm run test:app -w apps/web-shell',
    ].join(' && ');
  }
  await writeFile(targetManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function collectPublicCiMirrorExportViolations(rootDir, options) {
  const root = path.resolve(rootDir);
  const filePaths = options?.filePaths ?? (await collectFiles(root));
  const violations = [];

  for (const relativePath of filePaths) {
    violations.push(...collectPathViolations(relativePath));
    const filePath = path.join(root, relativePath);
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      violations.push({
        code: 'forbidden_symlink',
        message: `public CI mirror export would include a symlink: ${relativePath}`,
        path: relativePath,
      });
      continue;
    }
    if (!(await isTextFile(filePath))) {
      continue;
    }
    const contents = await readFile(filePath, 'utf8');
    violations.push(
      ...collectContentViolations(relativePath, contents, {
        includePublicOutputPatterns:
          options?.includePublicOutputPatterns === true,
      }),
    );
  }

  return violations;
}

async function collectIncludedFiles(sourceRoot, includePaths) {
  const files = [];
  for (const includePath of includePaths) {
    const relativePath = normalizeRelativePath(includePath);
    const includeViolations = collectPathViolations(relativePath);
    if (includeViolations.length > 0) {
      throw new Error(formatExportViolations(includeViolations));
    }

    const absolutePath = path.join(sourceRoot, relativePath);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        throw new Error(
          `public CI mirror include path is missing: ${relativePath}`,
        );
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(
        formatExportViolations([
          {
            code: 'forbidden_symlink',
            message: `public CI mirror include path is a symlink: ${relativePath}`,
            path: relativePath,
          },
        ]),
      );
    }

    if (stats.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, relativePath)));
      continue;
    }

    if (!stats.isFile()) {
      throw new Error(
        `public CI mirror include path is not a file: ${relativePath}`,
      );
    }
    files.push(relativePath);
  }

  return [...new Set(files)].sort();
}

async function collectFiles(rootDir, prefix = '') {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = normalizeRelativePath(path.join(prefix, entry.name));
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      files.push(relativePath);
      continue;
    }
    if (entry.isDirectory()) {
      if (isSourceRecursionExcludedDirectoryName(entry.name)) {
        continue;
      }
      files.push(...(await collectFiles(absolutePath, relativePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function isSourceRecursionExcludedDirectoryName(value) {
  return (
    SOURCE_RECURSION_EXCLUDED_DIRECTORY_NAMES.has(value) ||
    value.startsWith('.audit')
  );
}

function collectPathViolations(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const segments = normalizedPath.split('/');
  const basename = segments.at(-1) ?? normalizedPath;
  const violations = [];

  if (
    FORBIDDEN_FILE_EXACT.has(normalizedPath) ||
    FORBIDDEN_FILE_BASENAMES.has(basename) ||
    basename === 'provider.json' ||
    isForbiddenEnvFileName(basename)
  ) {
    violations.push({
      code: 'forbidden_public_mirror_file',
      message: `public CI mirror export would include a forbidden file: ${normalizedPath}`,
      path: normalizedPath,
    });
  }

  if (
    segments.some(
      (segment) =>
        FORBIDDEN_DIRECTORY_NAMES.has(segment) ||
        segment.startsWith('.audit') ||
        (segment === '.geulbat' && segments.includes('auth')),
    )
  ) {
    violations.push({
      code: 'forbidden_public_mirror_directory',
      message: `public CI mirror export would include a forbidden directory path: ${normalizedPath}`,
      path: normalizedPath,
    });
  }

  return violations;
}

function collectContentViolations(relativePath, contents, options) {
  const violations = [];
  const descriptors = options?.includePublicOutputPatterns
    ? [...CONTENT_PATTERNS, ...PUBLIC_OUTPUT_CONTENT_PATTERNS]
    : CONTENT_PATTERNS;

  for (const descriptor of descriptors) {
    descriptor.pattern.lastIndex = 0;
    for (const match of contents.matchAll(descriptor.pattern)) {
      const value = match[0];
      if (isPublicSafeFixtureLiteral(relativePath, descriptor.code, value)) {
        continue;
      }
      violations.push({
        code: descriptor.code,
        message: `public CI mirror export found ${descriptor.reason} in ${relativePath}`,
        path: relativePath,
        snippet: readLineSnippet(contents, match.index ?? 0),
      });
    }
  }
  return violations;
}

function isPublicSafeFixtureLiteral(relativePath, code, value) {
  const isExporterPolicyLiteral =
    relativePath === 'scripts/export-public-ci-mirror.mjs';
  return PUBLIC_SAFE_FIXTURE_ALLOWLIST.some(
    (entry) =>
      (entry.path === relativePath || isExporterPolicyLiteral) &&
      entry.code === code &&
      (entry.value === value ||
        (isExporterPolicyLiteral &&
          JSON.stringify(entry.value).slice(1, -1).includes(value))),
  );
}

function isForbiddenEnvFileName(value) {
  return (
    value === '.env' || (value.startsWith('.env.') && value !== '.env.example')
  );
}

async function isTextFile(filePath) {
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) {
    return false;
  }
  return true;
}

function normalizeRelativePath(value) {
  const normalized = String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
  if (
    path.isAbsolute(normalized) ||
    normalized === '' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`public CI mirror path must be repo-relative: ${value}`);
  }
  return normalized.replace(/\/+$/u, '');
}

function readRequiredString(options, key) {
  const value = options?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readOptionValue(name, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value\n${readUsage()}`);
  }
  return value;
}

function formatExportViolations(violations) {
  return [
    'public CI mirror export failed:',
    ...violations.map(
      (violation) =>
        `${violation.code}: ${violation.path}: ${violation.message}`,
    ),
  ].join('\n');
}

function readLineSnippet(contents, index) {
  const lineStart = contents.lastIndexOf('\n', index) + 1;
  const lineEnd = contents.indexOf('\n', index);
  return contents.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
}

function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeErrorWithCode(error, code) {
  return (
    error instanceof Error &&
    'code' in error &&
    Reflect.get(error, 'code') === code
  );
}

function readUsage() {
  return [
    'Usage:',
    '  node scripts/export-public-ci-mirror.mjs --output <path> [--source-root <path>] [--force]',
    '',
    'The output path must be outside the source repository.',
    'The export is allowlist-based and fails closed before writing forbidden source content.',
  ].join('\n');
}

async function main() {
  const options = parseExportPublicCiMirrorArgs(process.argv.slice(2));
  const result = await exportPublicCiMirror(options);
  console.log(`public CI mirror export written: ${result.outputDir}`);
  console.log(`files=${result.copiedFileCount}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
