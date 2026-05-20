import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';

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
        projectService: true,
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
        { type: 'shared-utils', pattern: ['packages/shared-utils/src/**'] },
        { type: 'protocol', pattern: ['packages/protocol/src/**'] },
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
          type: 'feature-editor',
          pattern: ['apps/web-shell/src/features/editor/**'],
        },
        {
          type: 'feature-project-selector',
          pattern: ['apps/web-shell/src/features/project-selector/**'],
        },
        {
          type: 'feature-project-tree',
          pattern: ['apps/web-shell/src/features/project-tree/**'],
        },
        {
          type: 'feature-provider-auth',
          pattern: ['apps/web-shell/src/features/provider-auth/**'],
        },
        {
          type: 'feature-thread-list',
          pattern: ['apps/web-shell/src/features/thread-list/**'],
        },
        { type: 'adapter-web', pattern: ['apps/daemon/src/adapter/web/**'] },
        {
          type: 'daemon-kernel',
          pattern: [
            'apps/daemon/src/daemon/error-codes.ts',
            'apps/daemon/src/daemon/port.ts',
            'apps/daemon/src/daemon/run-workspace-context.ts',
            'apps/daemon/src/daemon/runtime-contracts.ts',
            'apps/daemon/src/daemon/subagent-runtime-contracts.ts',
          ],
          mode: 'full',
        },
        {
          type: 'daemon-composition',
          pattern: [
            'apps/daemon/src/bootstrap-daemon-context.ts',
            'apps/daemon/src/create-daemon.ts',
            'apps/daemon/src/daemon-server-lifecycle.ts',
            'apps/daemon/src/repo-root.ts',
            'apps/daemon/src/daemon/context.ts',
            'apps/daemon/src/daemon/daemon-runtime-contract.ts',
            'apps/daemon/src/daemon/runtime-persistence-file-access.ts',
            'apps/daemon/src/daemon/runtime-services.ts',
            'apps/daemon/src/daemon/workspace-admission-lock.ts',
          ],
          mode: 'full',
        },
        { type: 'daemon-agent', pattern: ['apps/daemon/src/daemon/agent/**'] },
        { type: 'daemon-auth', pattern: ['apps/daemon/src/daemon/auth/**'] },
        {
          type: 'daemon-memory',
          pattern: ['apps/daemon/src/daemon/memory/**'],
        },
        {
          type: 'daemon-network',
          pattern: ['apps/daemon/src/daemon/network/**'],
        },
        { type: 'daemon-tools', pattern: ['apps/daemon/src/daemon/tools/**'] },
        { type: 'daemon-llm', pattern: ['apps/daemon/src/daemon/llm/**'] },
        {
          type: 'daemon-artifact-runtime-persistence',
          pattern: ['apps/daemon/src/daemon/artifact-runtime-persistence/**'],
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
          type: 'daemon-sessions',
          pattern: ['apps/daemon/src/daemon/sessions/**'],
        },
        { type: 'daemon-files', pattern: ['apps/daemon/src/daemon/files/**'] },
        { type: 'daemon-utils', pattern: ['apps/daemon/src/daemon/utils/**'] },
        {
          type: 'daemon-entry',
          pattern: [
            'apps/daemon/src/bootstrap-entry.ts',
            'apps/daemon/src/index.ts',
            'apps/daemon/src/main.ts',
            'apps/daemon/src/env-local.ts',
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
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: { type: 'shared-utils' }, allow: [] },
            { from: { type: 'protocol' }, allow: [] },
            {
              from: { type: 'web-shell-test' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'shared-utils',
                    'web-shell-entry',
                    'web-shell-app',
                    'web-shell-lib',
                    'feature-approvals',
                    'feature-artifacts',
                    'feature-assistant',
                    'feature-editor',
                    'feature-project-selector',
                    'feature-project-tree',
                    'feature-provider-auth',
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
                    'shared-utils',
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
                    'shared-utils',
                    'web-shell-app',
                    'web-shell-lib',
                    'feature-approvals',
                    'feature-artifacts',
                    'feature-assistant',
                    'feature-editor',
                    'feature-project-selector',
                    'feature-project-tree',
                    'feature-provider-auth',
                    'feature-thread-list',
                  ],
                },
              },
            },
            {
              from: { type: 'web-shell-lib' },
              allow: {
                to: { type: ['protocol', 'shared-utils', 'web-shell-lib'] },
              },
            },
            {
              from: { type: 'feature-approvals' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'shared-utils',
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
                    'protocol',
                    'shared-utils',
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
                    'shared-utils',
                    'web-shell-lib',
                    'feature-artifacts',
                    'feature-assistant',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-editor' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'shared-utils',
                    'web-shell-lib',
                    'feature-editor',
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
                    'shared-utils',
                    'web-shell-lib',
                    'feature-project-selector',
                  ],
                },
              },
            },
            {
              from: { type: 'feature-project-tree' },
              allow: {
                to: {
                  type: [
                    'protocol',
                    'shared-utils',
                    'web-shell-lib',
                    'feature-project-tree',
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
                    'shared-utils',
                    'web-shell-lib',
                    'feature-provider-auth',
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
                    'shared-utils',
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
                    'shared-utils',
                    'protocol',
                    'adapter-web',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-agent',
                    'daemon-auth',
                    'daemon-memory',
                    'daemon-network',
                    'daemon-tools',
                    'daemon-llm',
                    'daemon-artifact-runtime-persistence',
                    'daemon-react-bundle-inline',
                    'daemon-sandbox',
                    'daemon-sessions',
                    'daemon-files',
                    'daemon-utils',
                    'daemon-entry',
                  ],
                },
              },
            },
            {
              from: { type: 'adapter-web' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'protocol',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-auth',
                    'daemon-agent',
                    'daemon-artifact-runtime-persistence',
                    'daemon-react-bundle-inline',
                    'daemon-sessions',
                    'daemon-files',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-agent' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-memory',
                    'daemon-tools',
                    'daemon-sessions',
                    'daemon-files',
                    'daemon-llm',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-tools' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'protocol',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-files',
                    'daemon-memory',
                    'daemon-network',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-network' },
              allow: {
                to: {
                  type: ['daemon-network'],
                },
              },
            },
            {
              from: { type: 'daemon-llm' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'daemon-auth',
                    'daemon-kernel',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-artifact-runtime-persistence' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-files' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
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
                    'shared-utils',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-utils',
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
                    'shared-utils',
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
                  type: ['daemon-files', 'daemon-network', 'daemon-utils'],
                },
              },
            },
            {
              from: { type: 'daemon-memory' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-files',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-kernel' },
              allow: {
                to: {
                  type: ['shared-utils', 'protocol', 'daemon-utils'],
                },
              },
            },
            {
              from: { type: 'daemon-composition' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'protocol',
                    'adapter-web',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-agent',
                    'daemon-auth',
                    'daemon-memory',
                    'daemon-tools',
                    'daemon-llm',
                    'daemon-artifact-runtime-persistence',
                    'daemon-sessions',
                    'daemon-files',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-utils' },
              allow: { to: { type: ['shared-utils', 'daemon-kernel'] } },
            },
            {
              from: { type: 'daemon-sessions' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'daemon-kernel',
                    'daemon-composition',
                    'daemon-files',
                    'daemon-utils',
                  ],
                },
              },
            },
            {
              from: { type: 'daemon-entry' },
              allow: {
                to: {
                  type: [
                    'shared-utils',
                    'protocol',
                    'adapter-web',
                    'daemon-kernel',
                    'daemon-entry',
                    'daemon-composition',
                    'daemon-auth',
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
    files: [
      'apps/web-shell/src/features/assistant/**/*.ts',
      'apps/web-shell/src/features/assistant/**/*.tsx',
    ],
    ignores: [
      'apps/web-shell/src/features/assistant/artifact.test.ts',
      'apps/web-shell/src/features/assistant/test-support/**/*.ts',
      'apps/web-shell/src/features/assistant/test-support/**/*.tsx',
      'apps/web-shell/src/features/assistant/artifacts/artifact-envelope.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                './artifacts/artifact-envelope.js',
                '../artifacts/artifact-envelope.js',
                '../../artifacts/artifact-envelope.js',
              ],
              message:
                'artifact-envelope is legacy migration scaffolding. Do not import it outside dedicated tests/test-support.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-shell/src/**/*.ts', 'apps/web-shell/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not import the protocol root barrel in web-shell source code. Use protocol subpaths or the local protocol facade instead.',
        },
        {
          selector: "ImportDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not import the shared-utils root barrel in web-shell source code. Use shared-utils subpaths instead.',
        },
        {
          selector: "ExportNamedDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in web-shell source code. Re-export protocol subpaths or the local protocol facade instead.',
        },
        {
          selector:
            "ExportNamedDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not re-export the shared-utils root barrel in web-shell source code. Re-export shared-utils subpaths instead.',
        },
        {
          selector: "ExportAllDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in web-shell source code. Re-export protocol subpaths or the local protocol facade instead.',
        },
        {
          selector:
            "ExportAllDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not re-export the shared-utils root barrel in web-shell source code. Re-export shared-utils subpaths instead.',
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
          selector: "ImportDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not import the shared-utils root barrel in daemon source code. Use shared-utils subpaths instead.',
        },
        {
          selector: "ExportNamedDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in daemon source code. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportNamedDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not re-export the shared-utils root barrel in daemon source code. Re-export shared-utils subpaths instead.',
        },
        {
          selector: "ExportAllDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in daemon source code. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportAllDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not re-export the shared-utils root barrel in daemon source code. Re-export shared-utils subpaths instead.',
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
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not import the protocol root barrel in app scripts. Use protocol subpaths instead.',
        },
        {
          selector: "ImportDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not import the shared-utils root barrel in app scripts. Use shared-utils subpaths instead.',
        },
        {
          selector: "ExportNamedDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in app scripts. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportNamedDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not re-export the shared-utils root barrel in app scripts. Re-export shared-utils subpaths instead.',
        },
        {
          selector: "ExportAllDeclaration[source.value='@geulbat/protocol']",
          message:
            'Do not re-export the protocol root barrel in app scripts. Re-export protocol subpaths instead.',
        },
        {
          selector:
            "ExportAllDeclaration[source.value='@geulbat/shared-utils']",
          message:
            'Do not re-export the shared-utils root barrel in app scripts. Re-export shared-utils subpaths instead.',
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
            {
              name: './use-project-registry.js',
              message:
                'Import app-level project registry wiring through use-app-shell.js.',
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
              name: './use-project-registry.js',
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
    files: [
      'apps/web-shell/src/app/run-session-diagnostics.ts',
      'apps/web-shell/src/app/use-project-registry.ts',
      'apps/web-shell/src/app/run-session-controller-actions.ts',
      'apps/web-shell/src/app/run-session-lifecycle.ts',
      'apps/web-shell/src/app/run-session-settle.ts',
      'apps/web-shell/src/app/use-thread-sessions.ts',
      'apps/web-shell/src/app/use-provider-auth-state.ts',
      'apps/web-shell/src/app/use-run-session-connection.ts',
      'apps/web-shell/src/app/use-workspace-files.ts',
      'apps/web-shell/src/features/approvals/Approvals.tsx',
      'apps/web-shell/src/features/editor/Editor.tsx',
      'apps/web-shell/src/features/project-tree/ProjectTree.tsx',
      'apps/web-shell/src/features/assistant/AssistantTranscript.tsx',
      'apps/web-shell/src/features/assistant/export/use-artifact-export-state.ts',
      'apps/web-shell/src/features/assistant/export/use-generated-binary-export-state.ts',
      'apps/web-shell/src/features/assistant/artifact-pane/use-pane-state.ts',
      'apps/web-shell/src/features/assistant/runtime-frame/use-artifact-runtime-frame-state.ts',
      'apps/web-shell/src/features/artifacts/use-artifact-streaming-preview-payload.ts',
      'apps/web-shell/src/features/thread-list/ThreadList.tsx',
    ],
    rules: {
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: [
      'packages/*/src/**/*.test.ts',
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
      '@typescript-eslint/no-misused-promises': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'boundaries/dependencies': 'off',
    },
  },
];
