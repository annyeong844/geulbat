import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';

const useExternalTypedLintAdapter =
  process.env.GEULBAT_TYPED_LINT_ADAPTER === 'tsgolint';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/dist-node/**',
      '**/node_modules/**',
      '**/.tmp-rustlike*/**',
      '**/*.js',
    ],
  },

  {
    files: [
      'packages/*/src/**/*.ts',
      'apps/*/src/**/*.ts',
      'apps/*/src/**/*.tsx',
    ],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/src/test-support/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        jsDocParsingMode: 'none',
        projectService: !useExternalTypedLintAdapter,
        sourceType: 'module',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      boundaries,
      'react-hooks': reactHooks,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.app.json'],
          noWarnOnMultipleProjects: true,
        },
      },
      'boundaries/elements': [
        {
          type: 'agent-loop',
          pattern: [
            'packages/agent-loop/src/**',
            'packages/agent-loop/dist/**',
          ],
        },
        {
          type: 'xharness',
          pattern: ['packages/xharness/src/**', 'packages/xharness/dist/**'],
        },
        {
          type: 'artifact-runtime-policy',
          pattern: [
            'packages/artifact-runtime-policy/src/**',
            'packages/artifact-runtime-policy/dist/**',
          ],
        },
        {
          type: 'content-identity',
          pattern: [
            'packages/content-identity/src/**',
            'packages/content-identity/dist/**',
          ],
        },
        {
          type: 'structured-logger',
          pattern: [
            'packages/structured-logger/src/**',
            'packages/structured-logger/dist/**',
          ],
        },
        {
          type: 'protocol',
          pattern: ['packages/protocol/src/**', 'packages/protocol/dist/**'],
        },
        {
          type: 'tool-library',
          pattern: [
            'packages/tool-library/src/**',
            'packages/tool-library/dist/**',
          ],
        },
        {
          type: 'tool-sdk',
          pattern: ['packages/tool-sdk/src/**', 'packages/tool-sdk/dist/**'],
        },
        { type: 'geulbat-product', pattern: ['apps/geulbat/src/**'] },
        {
          type: 'geulbat-product-test',
          pattern: ['apps/geulbat/src/**/*.test.ts'],
        },
        { type: 'geulbat-lab', pattern: ['apps/geulbat-lab/src/**'] },
        {
          type: 'geulbat-lab-test',
          pattern: ['apps/geulbat-lab/src/**/*.test.ts'],
        },
        {
          type: 'web-shell-entry',
          pattern: ['apps/web-shell/src/*.ts', 'apps/web-shell/src/*.tsx'],
          mode: 'full',
        },
        { type: 'web-shell-app', pattern: ['apps/web-shell/src/app/**'] },
        { type: 'web-shell-lib', pattern: ['apps/web-shell/src/lib/**'] },
        {
          type: 'feature-approvals',
          pattern: ['apps/web-shell/src/features/approvals/**'],
        },
        {
          type: 'feature-artifacts',
          pattern: ['apps/web-shell/src/features/artifacts/**'],
        },
        {
          type: 'feature-assistant',
          pattern: ['apps/web-shell/src/features/assistant/**'],
        },
        {
          type: 'feature-browser-share',
          pattern: ['apps/web-shell/src/features/browser-share/**'],
        },
        {
          type: 'feature-browser-live-session',
          pattern: ['apps/web-shell/src/features/browser-live-session/**'],
        },
        {
          type: 'feature-editor',
          pattern: ['apps/web-shell/src/features/editor/**'],
        },
        {
          type: 'feature-mcp',
          pattern: ['apps/web-shell/src/features/mcp/**'],
        },
        {
          type: 'feature-plugins',
          pattern: ['apps/web-shell/src/features/plugins/**'],
        },
        {
          type: 'feature-project-selector',
          pattern: ['apps/web-shell/src/features/project-selector/**'],
        },
        {
          type: 'feature-computer-tree',
          pattern: ['apps/web-shell/src/features/computer-tree/**'],
        },
        {
          type: 'feature-provider-auth',
          pattern: ['apps/web-shell/src/features/provider-auth/**'],
        },
        {
          type: 'feature-provider-usage',
          pattern: ['apps/web-shell/src/features/provider-usage/**'],
        },
        {
          type: 'feature-thread-list',
          pattern: ['apps/web-shell/src/features/thread-list/**'],
        },
        { type: 'adapter-web', pattern: ['apps/daemon/src/adapter/web/**'] },
        {
          type: 'daemon-process-execution',
          pattern: [
            'apps/daemon/src/daemon/command-environment.ts',
            'apps/daemon/src/daemon/docker-client-command.ts',
            'apps/daemon/src/daemon/docker-host-command.ts',
            'apps/daemon/src/daemon/host-routed-command.ts',
            'apps/daemon/src/daemon/host-routed-detached-process.ts',
            'apps/daemon/src/daemon/system-command.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-host-command',
          pattern: [
            'apps/daemon/src/daemon/host-command-runtime.ts',
            'apps/daemon/src/daemon/host-command-output-store.ts',
            'apps/daemon/src/command-host/**',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-kernel',
          pattern: [
            'apps/daemon/src/daemon/artifact-candidate.ts',
            'apps/daemon/src/daemon/error-codes.ts',
            'apps/daemon/src/daemon/planning-approval.ts',
            'apps/daemon/src/daemon/port.ts',
            'apps/daemon/src/daemon/runtime-json.ts',
            'apps/daemon/src/daemon/run-context.ts',
            'apps/daemon/src/daemon/runtime-contracts.ts',
            'apps/daemon/src/daemon/subagent-runtime-contracts.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-composition',
          pattern: [
            'apps/daemon/src/create-daemon.ts',
            'apps/daemon/src/daemon-runtime-owner.ts',
            'apps/daemon/src/daemon-server-lifecycle.ts',
            'apps/daemon/src/home-state-root.ts',
            'apps/daemon/src/daemon/context.ts',
            'apps/daemon/src/daemon/react-bundle-docker-command-runner.ts',
            'apps/daemon/src/daemon/computer-discovery-command-runner.ts',
            'apps/daemon/src/daemon/ptc-execute-code-terminal-result-store.ts',
            'apps/daemon/src/daemon/plugin-mcp-coordinator.ts',
            'apps/daemon/src/daemon/daemon-runtime-contract.ts',
            'apps/daemon/src/daemon/runtime-persistence-file-access.ts',
            'apps/daemon/src/daemon/permission-mode-store.ts',
            'apps/daemon/src/daemon/provider-usage.ts',
            'apps/daemon/src/daemon/plan-state-store.ts',
            'apps/daemon/src/daemon/directory-preferences-store.ts',
            'apps/daemon/src/daemon/runtime-state-store.ts',
            'apps/daemon/src/daemon/runtime-state-database.ts',
            'apps/daemon/src/daemon/runtime-state-migration-ladder.ts',
            'apps/daemon/src/daemon/runtime-state-mcp-session-store.ts',
            'apps/daemon/src/daemon/runtime-state-subagent-launch-store.ts',
            'apps/daemon/src/daemon/runtime-state-subagent-terminal-delivery-store.ts',
            'apps/daemon/src/daemon/runtime-services.ts',
            'apps/daemon/src/daemon/daemon-instance-admission-lock.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-agent-sandbox-ingress',
          pattern: [
            'apps/daemon/src/daemon/agent/react-bundle-explicit-cdn-artifact-ingress.ts',
            'apps/daemon/src/daemon/agent/react-bundle-structured-output-caller.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-agent-contract',
          pattern: ['apps/daemon/src/daemon/agent/contract.ts'],
          mode: 'full',
        },
        { type: 'daemon-agent', pattern: ['apps/daemon/src/daemon/agent/**'] },
        {
          type: 'daemon-auth-contract',
          pattern: ['apps/daemon/src/daemon/auth/contract.ts'],
          mode: 'full',
        },
        { type: 'daemon-auth', pattern: ['apps/daemon/src/daemon/auth/**'] },
        {
          type: 'daemon-memory',
          pattern: ['apps/daemon/src/daemon/memory/**'],
        },
        {
          type: 'daemon-memories',
          pattern: ['apps/daemon/src/daemon/memories/**'],
        },
        {
          type: 'daemon-mcp',
          pattern: ['apps/daemon/src/daemon/mcp/**'],
        },
        {
          type: 'daemon-extensions',
          pattern: ['apps/daemon/src/daemon/extensions/**'],
        },
        {
          type: 'daemon-network',
          pattern: ['apps/daemon/src/daemon/network/**'],
        },
        { type: 'daemon-tools', pattern: ['apps/daemon/src/daemon/tools/**'] },
        { type: 'daemon-llm', pattern: ['apps/daemon/src/daemon/llm/**'] },
        {
          type: 'daemon-media-contract',
          pattern: ['apps/daemon/src/daemon/media/contract.ts'],
          mode: 'full',
        },
        { type: 'daemon-media', pattern: ['apps/daemon/src/daemon/media/**'] },
        {
          type: 'daemon-artifact-runtime-persistence-contract',
          pattern: [
            'apps/daemon/src/daemon/artifact-runtime-persistence/contract.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-artifact-runtime-persistence',
          pattern: ['apps/daemon/src/daemon/artifact-runtime-persistence/**'],
        },
        {
          type: 'daemon-react-bundle-dependency-admission',
          pattern: [
            'apps/daemon/src/daemon/react-bundle-dependency-admission/**',
          ],
        },
        {
          type: 'daemon-react-bundle-inline',
          pattern: ['apps/daemon/src/daemon/react-bundle-inline/**'],
        },
        {
          type: 'daemon-sandbox',
          pattern: ['apps/daemon/src/daemon/sandbox/**'],
        },
        {
          type: 'daemon-ptc-sandbox-ingress',
          pattern: [
            'apps/daemon/src/daemon/ptc/lab/artifacts/lab-artifact-workspace.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-runtime-contract',
          pattern: [
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-navigate-runtime-contract.ts',
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-page-load-evidence-runtime-contract.ts',
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-text-evidence-runtime-contract.ts',
            'apps/daemon/src/daemon/ptc/runtime/execute-code/execute-code-runtime-contract.ts',
            'apps/daemon/src/daemon/ptc/runtime/probes/fixed-probe-runtime-contract.ts',
            'apps/daemon/src/daemon/ptc/lab/shell/lab-session-batch-command-contract.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-runtime-ingress',
          pattern: [
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-live-session-runtime.ts',
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-navigate-runtime.ts',
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-page-load-evidence-runtime.ts',
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-text-evidence-runtime.ts',
            'apps/daemon/src/daemon/ptc/runtime/probes/fixed-probe-runtime.ts',
            'apps/daemon/src/daemon/ptc/runtime/execute-code/execute-code-runtime.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-runtime-ingress-helper',
          pattern: [
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-state-runtime.ts',
            'apps/daemon/src/daemon/ptc/runtime/browser/browser-live-session-media-endpoint.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-runtime-common',
          pattern: ['apps/daemon/src/daemon/ptc/runtime/runtime-state.ts'],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-lab-spine',
          pattern: ['apps/daemon/src/daemon/ptc/shared/lab-spine.ts'],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-package-helpers',
          pattern: [
            'apps/daemon/src/daemon/ptc/shared/positive-integer-env.ts',
            'apps/daemon/src/daemon/ptc/shared/record-shape.ts',
            'apps/daemon/src/daemon/ptc/shared/stable-identity.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-shared',
          pattern: ['apps/daemon/src/daemon/ptc/shared/**'],
        },
        {
          type: 'daemon-ptc-callback',
          pattern: ['apps/daemon/src/daemon/ptc/callback/**'],
        },
        {
          type: 'daemon-ptc-lab-artifacts',
          pattern: ['apps/daemon/src/daemon/ptc/lab/artifacts/**'],
        },
        {
          type: 'daemon-ptc-lab-browser-core',
          pattern: ['apps/daemon/src/daemon/ptc/lab/browser/core/**'],
        },
        {
          type: 'daemon-ptc-lab-browser-page-load-evidence',
          pattern: [
            'apps/daemon/src/daemon/ptc/lab/browser/page-load-evidence/**',
          ],
        },
        {
          type: 'daemon-ptc-lab-browser-text-evidence',
          pattern: ['apps/daemon/src/daemon/ptc/lab/browser/text-evidence/**'],
        },
        {
          type: 'daemon-ptc-lab-browser-live-session',
          pattern: ['apps/daemon/src/daemon/ptc/lab/browser/live-session/**'],
        },
        {
          type: 'daemon-ptc-lab-browser-user-url-navigation',
          pattern: [
            'apps/daemon/src/daemon/ptc/lab/browser/user-url-navigation/**',
          ],
        },
        {
          type: 'daemon-ptc-lab-browser',
          pattern: ['apps/daemon/src/daemon/ptc/lab/browser/**'],
        },
        {
          type: 'daemon-ptc-lab-network',
          pattern: ['apps/daemon/src/daemon/ptc/lab/network/**'],
        },
        {
          type: 'daemon-ptc-lab-packages',
          pattern: ['apps/daemon/src/daemon/ptc/lab/packages/**'],
        },
        {
          type: 'daemon-ptc-lab-profile',
          pattern: ['apps/daemon/src/daemon/ptc/lab/profile/**'],
        },
        {
          type: 'daemon-ptc-lab-session',
          pattern: ['apps/daemon/src/daemon/ptc/lab/session/**'],
        },
        {
          type: 'daemon-ptc-lab-shell',
          pattern: ['apps/daemon/src/daemon/ptc/lab/shell/**'],
        },
        {
          type: 'daemon-ptc-runtime-browser',
          pattern: ['apps/daemon/src/daemon/ptc/runtime/browser/**'],
        },
        {
          type: 'daemon-ptc-runtime-execute-code-sdk',
          pattern: [
            'apps/daemon/src/daemon/ptc/runtime/execute-code/execute-code-sdk.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-ptc-runtime-execute-code',
          pattern: ['apps/daemon/src/daemon/ptc/runtime/execute-code/**'],
        },
        {
          type: 'daemon-ptc-runtime-probes',
          pattern: ['apps/daemon/src/daemon/ptc/runtime/probes/**'],
        },
        {
          type: 'daemon-ptc',
          pattern: ['apps/daemon/src/daemon/ptc/**'],
        },
        {
          type: 'daemon-sessions-contract',
          pattern: ['apps/daemon/src/daemon/sessions/contract.ts'],
          mode: 'full',
        },
        {
          type: 'daemon-sessions',
          pattern: ['apps/daemon/src/daemon/sessions/**'],
        },
        {
          type: 'daemon-files-contract',
          pattern: ['apps/daemon/src/daemon/files/contract.ts'],
          mode: 'full',
        },
        { type: 'daemon-files', pattern: ['apps/daemon/src/daemon/files/**'] },
        { type: 'daemon-utils', pattern: ['apps/daemon/src/daemon/utils/**'] },
        {
          type: 'daemon-entry',
          pattern: [
            'apps/daemon/src/bootstrap-entry.ts',
            'apps/daemon/src/index.ts',
            'apps/daemon/src/main.ts',
            'apps/daemon/src/host.ts',
            'apps/daemon/src/env-local.ts',
            'apps/daemon/src/loop-implementation-admission.ts',
            'apps/daemon/src/process-fatal-logging.ts',
            'apps/daemon/src/prompt-component-identity.ts',
            'apps/daemon/src/run-evidence.ts',
            'apps/daemon/dist/bootstrap-entry.*',
            'apps/daemon/dist/host.*',
            'apps/daemon/dist/loop-implementation-admission.*',
            'apps/daemon/dist/process-fatal-logging.*',
            'apps/daemon/dist/prompt-component-identity.*',
            'apps/daemon/dist/run-evidence.*',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-test',
          pattern: [
            'apps/daemon/src/**/*.test.ts',
            'apps/daemon/src/test-support/**',
          ],
        },
        {
          type: 'web-shell-test',
          pattern: [
            'apps/web-shell/src/**/*.test.ts',
            'apps/web-shell/src/**/*.test.tsx',
            'apps/web-shell/src/test-support/**',
          ],
        },
      ],
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'separate-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': useExternalTypedLintAdapter
        ? 'off'
        : 'error',
      '@typescript-eslint/no-misused-promises': useExternalTypedLintAdapter
        ? 'off'
        : 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-promise-executor-return': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'prefer-object-has-own': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: { type: 'agent-loop' }, allow: [] },
            {
              from: { type: 'xharness' },
              allow: {
                to: {
                  type: ['agent-loop', 'content-identity', 'tool-library'],
                },
              },
            },
            {
              from: { type: 'geulbat-product-test' },
              allow: {
                to: {
                  type: ['daemon-entry', 'geulbat-product', 'xharness'],
                },
              },
            },
            {
              from: { type: 'geulbat-product' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'daemon-entry',
                    'structured-logger',
                    'xharness',
                  ],
                },
              },
            },
            // 랩(오프라인 평가·연구 레인)은 제품을 평가하는 쪽이라 제품을 향해
            // 의존한다. 역방향은 geulbat-product의 allow 목록에 geulbat-lab이
            // 없다는 사실로 막힌다 — 제품이 연구 코드를 끌어오면 lint가 잡는다.
            {
              from: { type: 'geulbat-lab-test' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'geulbat-lab',
                    'geulbat-product',
                    'xharness',
                  ],
                },
              },
            },
            {
              from: { type: 'geulbat-lab' },
              allow: {
                to: {
                  type: ['content-identity', 'geulbat-product', 'xharness'],
                },
              },
            },
            {
              from: { type: 'artifact-runtime-policy' },
              allow: { to: { type: ['protocol'] } },
            },
            { from: { type: 'content-identity' }, allow: [] },
            { from: { type: 'structured-logger' }, allow: [] },
            { from: { type: 'protocol' }, allow: [] },
            { from: { type: 'tool-sdk' }, allow: [] },
            {
              from: { type: 'tool-library' },
              allow: { to: { type: ['content-identity'] } },
            },
            {
              from: { type: 'web-shell-test' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-entry',
                    'web-shell-app',
                    'web-shell-lib',
                    'feature-approvals',
                    'feature-artifacts',
                    'feature-assistant',
                    'feature-browser-live-session',
                    'feature-browser-share',
                    'feature-editor',
                    'feature-mcp',
                    'feature-plugins',
                    'feature-project-selector',
                    'feature-computer-tree',
                    'feature-provider-auth',
                    'feature-provider-usage',
                    'feature-thread-list',
                  ],
                },
              },
            },
            {
              from: { type: 'web-shell-entry' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-app',
                    'web-shell-lib',
                  ],
                },
              },
            },
            {
              from: { type: 'web-shell-app' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-app',
                    'web-shell-lib',
                    'feature-approvals',
                    'feature-artifacts',
                    'feature-assistant',
                    'feature-browser-live-session',
                    'feature-browser-share',
                    'feature-editor',
                    'feature-mcp',
                    'feature-plugins',
                    'feature-project-selector',
                    'feature-computer-tree',
                    'feature-provider-auth',
                    'feature-provider-usage',
                    'feature-thread-list',
                  ],
                },
              },
            },
            {
              from: { type: 'web-shell-lib' },
              allow: {
                to: {
                  type: ['protocol', 'structured-logger', 'web-shell-lib'],
                },
              },
            },
            {
              from: { type: 'feature-approvals' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-approvals',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-artifacts' },
              allow: {
                to: {
                  type: [
                    'artifact-runtime-policy',
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-artifacts',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-assistant' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-artifacts',
                    'feature-assistant',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-browser-share' },
              allow: {
                to: {
                  type: ['protocol', 'structured-logger', 'web-shell-lib'],
                },
              },
            },
            {
              from: { type: 'feature-browser-live-session' },
              allow: {
                to: {
                  type: ['protocol', 'structured-logger', 'web-shell-lib'],
                },
              },
            },
            {
              from: { type: 'feature-editor' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-editor',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-mcp' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-mcp',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-plugins' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-plugins',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-project-selector' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-project-selector',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-computer-tree' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-computer-tree',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-provider-auth' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-provider-auth',
                  ],
                },
              },
            },
            {
              // 사용량 카드는 제공자 연결 카드의 스타일 토큰을 재사용한다 —
              // 설정 안에서 같은 결을 유지하려면 값을 복제하지 않고 공유한다.
              from: { type: 'feature-provider-usage' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-provider-auth',
                    'feature-provider-usage',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-thread-list' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'web-shell-lib',
                    'feature-thread-list',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-test' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'structured-logger',
                    'protocol',
                    'tool-sdk',
                    'adapter-web',
                    'daemon-process-execution',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-agent-contract',
                    'daemon-agent',
                    'daemon-auth',
                    'daemon-mcp',
                    'daemon-extensions',
                    'daemon-memory',
                    'daemon-network',
                    'daemon-tools',
                    'daemon-llm',
                    'daemon-artifact-runtime-persistence',
                    'daemon-react-bundle-dependency-admission',
                    'daemon-react-bundle-inline',
                    'daemon-sandbox',
                    'daemon-sessions-contract',
                    'daemon-sessions',
                    'daemon-files-contract',
                    'daemon-files',
                    'daemon-utils',
                    'daemon-entry',
                    'daemon-host-command',
                  ],
                },
              },
            },
            {
              from: { type: 'adapter-web' },
              allow: {
                to: {
                  type: [
                    'structured-logger',
                    'protocol',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-auth',
                    'daemon-agent',
                    'daemon-artifact-runtime-persistence',
                    'daemon-mcp',
                    'daemon-extensions',
                    'daemon-react-bundle-inline',
                    'daemon-sessions',
                    'daemon-files',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-agent-sandbox-ingress' },
              allow: {
                to: {
                  type: [
                    'daemon-agent-sandbox-ingress',
                    'daemon-agent',
                    'daemon-react-bundle-dependency-admission',
                    'daemon-sandbox',
                    'daemon-llm',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-agent' },
              allow: {
                to: {
                  type: [
                    'agent-loop',
                    'structured-logger',
                    'tool-library',
                    'daemon-kernel',
                    'daemon-agent-contract',
                    'daemon-agent-sandbox-ingress',
                    'daemon-composition',
                    'daemon-ptc-runtime-contract',
                    'daemon-memory',
                    'daemon-memories',
                    'daemon-tools',
                    'daemon-sessions',
                    'daemon-files',
                    'daemon-llm',
                    'daemon-utils',
                    'daemon-host-command',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-agent-contract' },
              allow: {
                to: {
                  type: ['protocol'],
                },
              },
            },
            {
              from: { type: 'daemon-tools' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'structured-logger',
                    'protocol',
                    'daemon-process-execution',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-ptc-runtime-contract',
                    'daemon-media-contract',
                    'daemon-files',
                    'daemon-memory',
                    'daemon-memories',
                    'daemon-network',
                    'daemon-utils',
                    'daemon-host-command',
                    'tool-library',
                    'tool-sdk',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-network' },
              allow: {
                to: {
                  // daemon-utils는 의존성 없는 리프다. 분리 실행의 단일
                  // 출구(runDetached)가 거기 살고, 계층마다 복제하면 그것이
                  // 곧 중복 오너다.
                  type: ['daemon-network', 'daemon-utils'],
                },
              },
            },
            {
              from: { type: 'daemon-mcp' },
              allow: {
                to: {
                  type: [
                    // P7.6 §4 A안 — MCP 서버 프로세스는 command-host 세션에
                    // 산다. 전송이 그 계약을 봐야 배치를 고를 수 있다.
                    'daemon-host-command',
                    'structured-logger',
                    'protocol',
                    'daemon-tools',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-extensions' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'daemon-process-execution',
                    'daemon-extensions',
                    'daemon-files',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-llm' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'structured-logger',
                    'daemon-auth',
                    'daemon-kernel',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-media' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'structured-logger',
                    'protocol',
                    'daemon-media-contract',
                    'daemon-kernel',
                    'daemon-auth',
                    'daemon-llm',
                    'daemon-sessions',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-media-contract' },
              allow: {
                to: {
                  type: ['protocol'],
                },
              },
            },
            {
              from: { type: 'daemon-artifact-runtime-persistence' },
              allow: {
                to: {
                  type: [
                    'structured-logger',
                    'daemon-artifact-runtime-persistence-contract',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-artifact-runtime-persistence-contract' },
              allow: {
                to: {
                  type: ['protocol'],
                },
              },
            },
            {
              from: { type: 'daemon-files' },
              allow: {
                to: {
                  type: [
                    'structured-logger',
                    'daemon-files-contract',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-auth' },
              allow: {
                to: {
                  type: [
                    'structured-logger',
                    'daemon-auth-contract',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-auth-contract' },
              allow: {
                to: {
                  type: ['protocol'],
                },
              },
            },
            {
              from: { type: 'daemon-react-bundle-dependency-admission' },
              allow: {
                to: {
                  type: [
                    'artifact-runtime-policy',
                    'content-identity',
                    'protocol',
                    'structured-logger',
                    'daemon-process-execution',
                    'daemon-network',
                    'daemon-sandbox',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-react-bundle-inline' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'structured-logger',
                    'daemon-react-bundle-inline',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-sandbox' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'structured-logger',
                    'daemon-files',
                    'daemon-network',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-sandbox-ingress' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-packages',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-shared',
                    'daemon-sandbox',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-runtime-contract' },
              allow: {
                to: {
                  type: ['daemon-ptc-shared'],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-runtime-ingress' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-callback',
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-browser-live-session',
                    'daemon-ptc-lab-browser-page-load-evidence',
                    'daemon-ptc-lab-browser-text-evidence',
                    'daemon-ptc-lab-browser-user-url-navigation',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-lab-shell',
                    'daemon-ptc-runtime-contract',
                    'daemon-ptc-runtime-common',
                    'daemon-ptc-runtime-execute-code',
                    'daemon-ptc-runtime-execute-code-sdk',
                    'daemon-ptc-runtime-ingress-helper',
                    'daemon-ptc-runtime-probes',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-runtime-ingress-helper' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-runtime-common',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-package-helpers' },
              allow: {
                to: {
                  type: ['content-identity', 'protocol', 'structured-logger'],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-shared' },
              allow: {
                to: {
                  type: ['content-identity', 'protocol', 'structured-logger'],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-callback' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-callback',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                    // 분리 실행의 단일 출구(runDetached)가 사는 리프 계층.
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-artifacts' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-packages',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-shared',
                    'daemon-sandbox',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-browser' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-lab-shell',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-browser-core' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-browser-page-load-evidence' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-browser-page-load-evidence',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-browser-text-evidence' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-browser-text-evidence',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-browser-live-session' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-browser-live-session',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-browser-user-url-navigation' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-browser-user-url-navigation',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-network' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-lab-shell',
                    'daemon-ptc-package-helpers',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-packages' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-packages',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-profile' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-packages',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-profile',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-session' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-packages',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-process-execution',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-lab-shell' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-lab-spine',
                    'daemon-ptc-lab-shell',
                    'daemon-ptc-runtime-contract',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-runtime-browser' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-lab-browser-core',
                    'daemon-ptc-lab-browser-page-load-evidence',
                    'daemon-ptc-lab-browser-text-evidence',
                    'daemon-ptc-lab-browser-user-url-navigation',
                    'daemon-ptc-lab-network',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-runtime-browser',
                    'daemon-ptc-runtime-contract',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-runtime-execute-code-sdk' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-runtime-contract',
                    'daemon-ptc-runtime-execute-code',
                    'tool-library',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-runtime-execute-code' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-callback',
                    // package install workflow product lane promotes the
                    // lab package smoke owners (validators/cache contract)
                    'daemon-ptc-lab-packages',
                    'daemon-ptc-lab-profile',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-lab-shell',
                    'daemon-process-execution',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-runtime-contract',
                    'daemon-ptc-runtime-execute-code',
                    'daemon-ptc-runtime-execute-code-sdk',
                    'daemon-ptc-shared',
                    // 분리 실행의 단일 출구(runDetached)가 사는 리프 계층.
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc-runtime-probes' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-callback',
                    'daemon-ptc-lab-session',
                    'daemon-ptc-package-helpers',
                    'daemon-ptc-runtime-contract',
                    'daemon-ptc-runtime-probes',
                    'daemon-ptc-shared',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-ptc' },
              allow: {
                to: {
                  type: [
                    'daemon-ptc-runtime-contract',
                    'daemon-ptc-package-helpers',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-memory' },
              allow: {
                to: {
                  type: [
                    'structured-logger',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-files',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-memories' },
              allow: {
                to: {
                  type: ['structured-logger', 'daemon-utils'],
                },
              },
            },
            {
              from: { type: 'daemon-process-execution' },
              allow: {
                to: {
                  // P7.6 — 이 계층이 데몬의 프로세스 소유를 대신 짊어진다.
                  // 자식을 직접 낳는 대신 command-host 세션으로 돌리려면 그
                  // 계약을 볼 수 있어야 한다.
                  type: [
                    'daemon-process-execution',
                    'daemon-host-command',
                    // 증분 host 세션의 관찰/종료 루프도 실패 소유자를 가져야
                    // 하므로 공용 detached 실행 출구만 허용한다.
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-host-command' },
              allow: {
                to: {
                  type: ['daemon-host-command', 'daemon-utils'],
                },
              },
            },
            {
              from: { type: 'daemon-kernel' },
              allow: {
                to: {
                  type: ['structured-logger', 'protocol', 'daemon-utils'],
                },
              },
            },
            {
              from: { type: 'daemon-composition' },
              allow: {
                to: {
                  type: [
                    'agent-loop',
                    'structured-logger',
                    'protocol',
                    'adapter-web',
                    'daemon-agent',
                    'daemon-kernel',
                    // P7.6 item 3 — 조립이 내부 명령의 실행 위치를 정한다.
                    'daemon-process-execution',
                    'daemon-composition',
                    'daemon-auth',
                    'daemon-memory',
                    'daemon-tools',
                    'daemon-llm',
                    'daemon-media-contract',
                    'daemon-media',
                    'daemon-mcp',
                    'daemon-extensions',
                    'daemon-artifact-runtime-persistence',
                    'daemon-ptc-runtime-contract',
                    'daemon-ptc-runtime-ingress',
                    'daemon-sandbox',
                    'daemon-sessions-contract',
                    'daemon-sessions',
                    'daemon-files-contract',
                    'daemon-files',
                    'daemon-utils',
                    'daemon-host-command',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-utils' },
              allow: { to: { type: ['structured-logger', 'daemon-kernel'] } },
            },
            {
              from: { type: 'daemon-sessions' },
              allow: {
                to: {
                  type: [
                    'content-identity',
                    'structured-logger',
                    'protocol',
                    'daemon-sessions-contract',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-files',
                    'daemon-utils',
                    'daemon-host-command',
                    'tool-library',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-sessions-contract' },
              allow: {
                to: {
                  type: ['protocol'],
                },
              },
            },
            {
              from: { type: 'daemon-files-contract' },
              allow: {
                to: {
                  type: ['protocol'],
                },
              },
            },
            {
              from: { type: 'daemon-entry' },
              allow: {
                to: {
                  type: [
                    'agent-loop',
                    'content-identity',
                    'structured-logger',
                    'protocol',
                    'adapter-web',
                    'daemon-agent',
                    'daemon-kernel',
                    'daemon-entry',
                    'daemon-composition',
                    'daemon-auth',
                    'daemon-sessions',
                    'daemon-utils',
                  ],
                },
              },
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/**/*.ts', 'apps/web-shell/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@geulbat/shared-utils', '@geulbat/shared-utils/*'],
              message:
                'The generic @geulbat/shared-utils owner is retired. Import the precise capability owner instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not import the protocol root barrel in web-shell source code. Use protocol subpaths or the local protocol facade instead.',
        },
        {
          selector:
            "ImportDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not import the structured-logger root barrel in web-shell source code. Use structured-logger subpaths instead.',
        },
        {
          selector: "ExportNamedDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in web-shell source code. Re-export protocol subpaths or the local protocol facade instead.',
        },
        {
          selector:
            "ExportNamedDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not re-export the structured-logger root barrel in web-shell source code. Re-export structured-logger subpaths instead.',
        },
        {
          selector: "ExportAllDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in web-shell source code. Re-export protocol subpaths or the local protocol facade instead.',
        },
        {
          selector:
            "ExportAllDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not re-export the structured-logger root barrel in web-shell source code. Re-export structured-logger subpaths instead.',
        },
      ],
    },
  },
  {
    files: ['apps/daemon/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@geulbat/shared-utils', '@geulbat/shared-utils/*'],
              message:
                'The generic @geulbat/shared-utils owner is retired. Import the precise capability owner instead.',
            },
            {
              group: ['**/auth/index.js', '**/files/index.js'],
              message:
                'Do not import daemon internal barrels. Import the concrete auth/files module directly.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not import the protocol root barrel in daemon source code. Use protocol subpaths instead.',
        },
        {
          selector:
            "ImportDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not import the structured-logger root barrel in daemon source code. Use structured-logger subpaths instead.',
        },
        {
          selector: "ExportNamedDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in daemon source code. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportNamedDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not re-export the structured-logger root barrel in daemon source code. Re-export structured-logger subpaths instead.',
        },
        {
          selector: "ExportAllDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in daemon source code. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportAllDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not re-export the structured-logger root barrel in daemon source code. Re-export structured-logger subpaths instead.',
        },
      ],
    },
  },
  {
    // 분리 실행(`void somethingAsync()`)은 거절을 아무도 받지 않는 상태를
    // 만들고, Node는 그것을 프로세스 종료로 승격한다 — 한 하위 시스템의
    // 실패가 데몬 전체를 죽인다. 데몬은 자기 이유로만 죽어야 하므로 분리
    // 실행은 소유자를 아는 단일 출구를 지난다.
    files: ['apps/daemon/src/**/*.ts'],
    ignores: [
      'apps/daemon/src/**/*.test.ts',
      'apps/daemon/src/test-support/**/*.ts',
      // command-host 워커는 별도 프로세스이고 자기 fail-fast 규율을 갖는다
      // (main.ts). 거기서 새는 거절은 워커를 죽이고, 데몬은 그것을 워커
      // 종료라는 값으로 관찰한다 — 봉쇄가 이미 프로세스 경계에 있다.
      'apps/daemon/src/command-host/**/*.ts',
      // 2026-07-25: 다른 세션이 편집 중인 파일들. 그 작업이 정착하면 이
      // 예외를 지우고 runDetached로 옮긴다.
      'apps/daemon/src/adapter/web/ws/run-channel-start.ts',
      'apps/daemon/src/adapter/web/ws/run-channel-socket-runtime.ts',
      'apps/daemon/src/daemon/sessions/live-run-events.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "UnaryExpression[operator='void'] > CallExpression",
          message:
            'Detached execution must go through runDetached(label, work) (daemon/utils/run-detached.ts) so its failure belongs to an owner instead of ending the daemon process.',
        },
      ],
    },
  },
  {
    files: ['apps/*/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@geulbat/shared-utils', '@geulbat/shared-utils/*'],
              message:
                'The generic @geulbat/shared-utils owner is retired. Import the precise capability owner instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not import the protocol root barrel in app scripts. Use protocol subpaths instead.',
        },
        {
          selector:
            "ImportDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not import the structured-logger root barrel in app scripts. Use structured-logger subpaths instead.',
        },
        {
          selector: "ExportNamedDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in app scripts. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportNamedDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not re-export the structured-logger root barrel in app scripts. Re-export structured-logger subpaths instead.',
        },
        {
          selector: "ExportAllDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in app scripts. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportAllDeclaration[source.value='@geulbat/structured-logger']",
          message:
            'Do not re-export the structured-logger root barrel in app scripts. Re-export structured-logger subpaths instead.',
        },
      ],
    },
  },
  {
    files: ['scripts/*.mjs', '.rustlike/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: ['apps/daemon/src/adapter/web/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../auth/*.js',
                '../request/*.js',
                '../response/*.js',
                '../origin-policy.js',
              ],
              message:
                'Import adapter/web cross-seam modules through the #web/* internal aliases.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/app/App.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './use-provider-auth-state.js',
              message:
                'Import app-level provider auth wiring through use-app-shell.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/app/app-shell.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './use-provider-auth-state.js',
              message:
                'Keep app-shell pure; hook wiring belongs in use-app-shell.js.',
            },
            {
              name: './App.js',
              message:
                'Keep app-shell pure; UI composition belongs in App.tsx.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/app/use-app-shell.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './ProjectWorkspace.js',
              message:
                'Map app-level state through app-shell.js, not ProjectWorkspace directly.',
            },
            {
              name: './project-workspace-shell.js',
              message:
                'App-level wiring should not depend on ProjectWorkspace shell internals.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/app/ProjectWorkspace.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './use-run-session.js',
              message:
                'Import run-session wiring through use-project-workspace-shell.js.',
            },
            {
              name: './use-thread-sessions.js',
              message:
                'Import thread session wiring through use-project-workspace-shell.js.',
            },
            {
              name: './use-workspace-files.js',
              message:
                'Import workspace file wiring through use-project-workspace-shell.js.',
            },
            {
              name: './project-workspace-run-session-view.js',
              message:
                'Import workspace run-session mapping through project-workspace-shell.js.',
            },
            {
              name: './project-workspace-panel-views.js',
              message:
                'Import workspace panel mapping through project-workspace-shell.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/app/project-workspace-shell.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './use-run-session.js',
              message:
                'Keep project-workspace-shell pure; hook wiring belongs in use-project-workspace-shell.js.',
            },
            {
              name: './use-thread-sessions.js',
              message:
                'Keep project-workspace-shell pure; hook wiring belongs in use-project-workspace-shell.js.',
            },
            {
              name: './use-workspace-files.js',
              message:
                'Keep project-workspace-shell pure; hook wiring belongs in use-project-workspace-shell.js.',
            },
            {
              name: './ProjectWorkspace.js',
              message:
                'Keep project-workspace-shell pure; UI composition belongs in ProjectWorkspace.tsx.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/app/use-project-workspace-shell.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './ProjectWorkspace.js',
              message:
                'Keep ProjectWorkspace composition above the workspace shell hook.',
            },
            {
              name: './project-workspace-panel-views.js',
              message:
                'Compose workspace panel mapping through project-workspace-shell.js.',
            },
            {
              name: './project-workspace-run-session-view.js',
              message:
                'Compose workspace run-session mapping through project-workspace-shell.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/features/assistant/AssistantTranscript.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='sourceRef'] > JSXExpressionContainer > ObjectExpression",
          message:
            'Assemble assistant artifact source refs through artifacts/artifact-source-ref.js.',
        },
        {
          selector:
            "VariableDeclarator[id.name='finalArtifactSourceRef'] > ObjectExpression",
          message:
            'Assemble assistant artifact source refs through artifacts/artifact-source-ref.js.',
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/features/assistant/ArtifactPane.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='sourceRef'] > ObjectExpression",
          message:
            'Assemble assistant artifact source refs through artifacts/artifact-source-ref.js.',
        },
      ],
    },
  },
  {
    files: [
      'apps/web-shell/src/features/assistant/**/*.ts',
      'apps/web-shell/src/features/assistant/**/*.tsx',
    ],
    ignores: [
      'apps/web-shell/src/features/assistant/**/*.test.ts',
      'apps/web-shell/src/features/assistant/**/*.test.tsx',
      'apps/web-shell/src/features/assistant/artifact-durability.ts',
      'apps/web-shell/src/features/assistant/artifacts/artifact-view-model.ts',
      'apps/web-shell/src/features/assistant/artifacts/artifact-source-ref.ts',
      'apps/web-shell/src/features/assistant/artifacts/artifact-types.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='./artifact-types.js'] ImportSpecifier[imported.name='sanitizeArtifactSourceInputRef']",
          message:
            'Only artifact source owners may import sanitizeArtifactSourceInputRef directly.',
        },
        {
          selector:
            "ImportDeclaration[source.value='./artifacts/artifact-types.js'] ImportSpecifier[imported.name='sanitizeArtifactSourceInputRef']",
          message:
            'Only artifact source owners may import sanitizeArtifactSourceInputRef directly.',
        },
        {
          selector:
            "ImportDeclaration[source.value='../artifacts/artifact-types.js'] ImportSpecifier[imported.name='sanitizeArtifactSourceInputRef']",
          message:
            'Only artifact source owners may import sanitizeArtifactSourceInputRef directly.',
        },
        {
          selector:
            "ImportDeclaration[source.value='../../artifacts/artifact-types.js'] ImportSpecifier[imported.name='sanitizeArtifactSourceInputRef']",
          message:
            'Only artifact source owners may import sanitizeArtifactSourceInputRef directly.',
        },
      ],
    },
  },
  {
    files: [
      'apps/web-shell/src/features/assistant/**/*.ts',
      'apps/web-shell/src/features/assistant/**/*.tsx',
    ],
    ignores: [
      'apps/web-shell/src/features/assistant/**/*.test.ts',
      'apps/web-shell/src/features/assistant/**/*.test.tsx',
      'apps/web-shell/src/features/assistant/artifact-durability.ts',
      'apps/web-shell/src/features/assistant/artifact-run-drafts.ts',
      'apps/web-shell/src/features/assistant/artifacts/artifact-view-model.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='./artifact-durability.js'] ImportSpecifier[imported.name='resolveArtifactDurabilitySourceAuthorityFromResolved']",
          message:
            'Resolve artifact durability authority through artifact view-model or run-draft owners.',
        },
        {
          selector:
            "ImportDeclaration[source.value='../artifact-durability.js'] ImportSpecifier[imported.name='resolveArtifactDurabilitySourceAuthorityFromResolved']",
          message:
            'Resolve artifact durability authority through artifact view-model or run-draft owners.',
        },
        {
          selector:
            "ImportDeclaration[source.value='../../artifact-durability.js'] ImportSpecifier[imported.name='resolveArtifactDurabilitySourceAuthorityFromResolved']",
          message:
            'Resolve artifact durability authority through artifact view-model or run-draft owners.',
        },
      ],
    },
  },
  {
    files: [
      'apps/web-shell/src/features/assistant/runtime-persistence/artifact-runtime-persistence.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '../artifacts/artifact-types.js',
              importNames: ['sanitizeArtifactSourceInputRef'],
              message:
                'Derive runtime persistence scope through artifacts/artifact-source-ref.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'apps/web-shell/src/features/assistant/runtime-frame/use-artifact-runtime-frame-state.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "VariableDeclarator[id.name='canonicalSourceRef'] > CallExpression > ArrowFunctionExpression > ObjectExpression",
          message:
            'Canonical artifact runtime source refs belong in artifacts/artifact-source-ref.js.',
        },
      ],
    },
  },
  {
    files: [
      'apps/web-shell/src/features/assistant/runtime-frame/artifact-runtime-frame-revision.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '../artifacts/artifact-types.js',
              importNames: ['sanitizeArtifactSourceInputRef'],
              message:
                'Canonical artifact runtime source refs belong in artifacts/artifact-source-ref.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/daemon/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: [
      'packages/artifact-runtime-policy/src/**/*.ts',
      'packages/content-identity/src/**/*.ts',
      'packages/protocol/src/**/*.ts',
    ],
    rules: {
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreClassFieldInitialValues: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/test-support/**/*.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
      'apps/*/src/test-support/**/*.ts',
      'apps/*/src/test-support/**/*.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        jsDocParsingMode: 'none',
        project: ['packages/*/tsconfig.test.json', 'apps/*/tsconfig.test.json'],
        sourceType: 'module',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'boundaries/dependencies': 'off',
    },
  },
];
