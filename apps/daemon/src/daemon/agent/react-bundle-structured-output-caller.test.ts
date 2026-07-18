import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
} from '@geulbat/protocol/public-web-fixtures';
import type { FunctionCall, ProviderStructuredOutput } from '../llm/index.js';
import type { HttpMetadataProbeRequestTransport } from '../network/http-metadata-probe.js';
import { createSandboxAttemptStore } from '../sandbox/attempt-store.js';
import type { ReactBundleDependencyPrepareRequest } from '../react-bundle-dependency-admission/react-bundle-dependency-prepare.js';
import {
  REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MAX_MS,
  REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV,
  resolveReactBundleStructuredOutputIngressPolicyFromEnv,
} from './react-bundle-structured-output-ingress-policy.js';
import {
  runReactBundleStructuredOutputCaller,
  type ReactBundleStructuredOutputCallerResult,
} from './react-bundle-structured-output-caller.js';

const DEPENDENCY_REQUEST: ReactBundleDependencyPrepareRequest = {
  entryUrl: `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH}`,
  runtimeDependencies: {
    importMap: {
      imports: {
        [PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER]:
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
      },
    },
    stylesheets: [
      PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
    ],
  },
  dependencyRefs: [
    {
      kind: 'esm_import',
      specifier: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
      packageName: 'geulbat-runtime-dependency-fixture',
      version: '1.0.0',
      provider: 'explicit_cdn',
      url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
      integrity: 'sha384-fixture',
    },
    {
      kind: 'stylesheet',
      packageName: 'geulbat-runtime-dependency-fixture',
      version: '1.0.0',
      provider: 'explicit_cdn',
      url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
    },
  ],
};

const NO_DEPENDENCY_REQUEST: ReactBundleDependencyPrepareRequest = {
  entryUrl: 'https://fixtures.geulbat.local/no-deps.js',
  runtimeDependencies: {},
  dependencyRefs: [],
};

function structuredOutput(payload: unknown): ProviderStructuredOutput {
  return {
    schemaVersion: 1,
    kind: 'react_bundle_explicit_cdn_artifact',
    payload,
  };
}

function toolCall(): FunctionCall {
  return {
    id: 'fc_1',
    callId: 'call_1',
    name: 'read_file',
    arguments: '{"path":"README.md"}',
  };
}

function transport(statuses: number[]): HttpMetadataProbeRequestTransport {
  let index = 0;
  return async (_url, options) => {
    const status = statuses[index++] ?? 200;
    return {
      status,
      location: null,
      contentType:
        options.method === 'HEAD' ? 'application/javascript' : 'text/plain',
      contentLength: 20,
      bytesRead: options.method === 'GET' ? 4 : 0,
    };
  };
}

async function withWorkspace<T>(
  fn: (workspaceRoot: string) => Promise<T>,
): Promise<T> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-structured-output-caller-'),
  );
  try {
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function assertOk(
  result: ReactBundleStructuredOutputCallerResult,
): asserts result is Extract<
  ReactBundleStructuredOutputCallerResult,
  { ok: true }
> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function assertFailure(
  result: ReactBundleStructuredOutputCallerResult,
  reasonCode: Exclude<
    ReactBundleStructuredOutputCallerResult,
    { ok: true }
  >['reasonCode'],
): asserts result is Exclude<
  ReactBundleStructuredOutputCallerResult,
  { ok: true }
> {
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, reasonCode);
}

void test('runReactBundleStructuredOutputCaller exercises dependency prepare/probe/accept/candidate/result stages', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-25T00:00:00.000Z',
    });

    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store,
      structuredOutputs: [structuredOutput(DEPENDENCY_REQUEST)],
      functionCalls: [],
      timeoutMs: 1000,
      now: () => '2026-05-25T12:00:00.000Z',
      probeTransport: transport([200, 200]),
    });

    assertOk(result);
    assert.equal(result.result.ok, true);
    assert.equal(result.result.finalProse, '');
    assert.equal(result.result.artifactCandidate?.renderer, 'react_bundle');
    assert.deepEqual(
      store.getAttempts().records.map((attempt) => attempt.jobKind),
      [
        'react_bundle_dependency_prepare',
        'react_bundle_dependency_network_probe',
      ],
    );
  });
});

void test('runReactBundleStructuredOutputCaller accepts no-dependency payloads with dependencyRefs empty array', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore();

    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store,
      structuredOutputs: [structuredOutput(NO_DEPENDENCY_REQUEST)],
      functionCalls: [],
      timeoutMs: 1000,
      probeTransport: async () => {
        throw new Error('no-dependency structured output should not probe');
      },
    });

    assertOk(result);
    assert.equal(result.result.finalProse, '');
    assert.equal(result.result.artifactCandidate?.renderer, 'react_bundle');
    assert.deepEqual(
      store.getAttempts().records.map((attempt) => attempt.jobKind),
      ['react_bundle_dependency_prepare'],
    );
  });
});

void test('runReactBundleStructuredOutputCaller does not synthesize an ingress timeout', async () => {
  await withWorkspace(async (workspaceRoot) => {
    let timeoutWasForwarded = false;

    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [structuredOutput(NO_DEPENDENCY_REQUEST)],
      functionCalls: [],
      runIngress: async (args) => {
        timeoutWasForwarded = 'timeoutMs' in args;
        return {
          ok: false,
          reasonCode: 'prepare_failed',
          message: 'synthetic prepare failure',
        };
      },
    });

    assertFailure(result, 'prepare_failed');
    assert.equal(timeoutWasForwarded, false);
  });
});

void test('runReactBundleStructuredOutputCaller forwards owner ingress policy timeout', async () => {
  await withWorkspace(async (workspaceRoot) => {
    let forwardedTimeoutMs: number | undefined;

    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [structuredOutput(DEPENDENCY_REQUEST)],
      functionCalls: [],
      ingressPolicy: { timeoutMs: 1234 },
      runIngress: async (args) => {
        forwardedTimeoutMs = args.timeoutMs;
        return {
          ok: false,
          reasonCode: 'prepare_failed',
          message: 'synthetic prepare failure',
        };
      },
    });

    assertFailure(result, 'prepare_failed');
    assert.equal(forwardedTimeoutMs, 1234);
  });
});

void test('runReactBundleStructuredOutputCaller lets direct timeout override owner ingress policy', async () => {
  await withWorkspace(async (workspaceRoot) => {
    let forwardedTimeoutMs: number | undefined;

    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [structuredOutput(DEPENDENCY_REQUEST)],
      functionCalls: [],
      ingressPolicy: { timeoutMs: 1234 },
      timeoutMs: 5678,
      runIngress: async (args) => {
        forwardedTimeoutMs = args.timeoutMs;
        return {
          ok: false,
          reasonCode: 'prepare_failed',
          message: 'synthetic prepare failure',
        };
      },
    });

    assertFailure(result, 'prepare_failed');
    assert.equal(forwardedTimeoutMs, 5678);
  });
});

void test('resolveReactBundleStructuredOutputIngressPolicyFromEnv accepts positive integer timeout policy', () => {
  assert.deepEqual(resolveReactBundleStructuredOutputIngressPolicyFromEnv({}), {
    timeoutMs: 30_000,
  });
  assert.deepEqual(
    resolveReactBundleStructuredOutputIngressPolicyFromEnv({
      [REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV]: ' 1234 ',
    }),
    { timeoutMs: 1234 },
  );
  assert.deepEqual(
    resolveReactBundleStructuredOutputIngressPolicyFromEnv({
      [REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV]: String(
        REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MAX_MS,
      ),
    }),
    { timeoutMs: REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MAX_MS },
  );
});

void test('resolveReactBundleStructuredOutputIngressPolicyFromEnv rejects invalid timeout policy values', () => {
  for (const value of [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    String(REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MAX_MS + 1),
    '9007199254740992',
  ]) {
    assert.throws(
      () =>
        resolveReactBundleStructuredOutputIngressPolicyFromEnv({
          [REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV]: value,
        }),
      new RegExp(
        `invalid ${REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV}`,
      ),
    );
  }
});

void test('runReactBundleStructuredOutputCaller rejects ambiguous structured outputs', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [
        structuredOutput(NO_DEPENDENCY_REQUEST),
        structuredOutput(NO_DEPENDENCY_REQUEST),
      ],
      functionCalls: [],
      timeoutMs: 1000,
    });

    assertFailure(result, 'structured_output_ambiguous');
  });
});

void test('runReactBundleStructuredOutputCaller rejects structured outputs mixed with tool calls', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [structuredOutput(NO_DEPENDENCY_REQUEST)],
      functionCalls: [toolCall()],
      timeoutMs: 1000,
    });

    assertFailure(result, 'structured_output_with_tool_calls');
  });
});

void test('runReactBundleStructuredOutputCaller rejects malformed payloads without inferring provenance', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [
        structuredOutput({
          entryUrl: 'https://fixtures.geulbat.local/app.js',
          runtimeDependencies: {},
        }),
      ],
      functionCalls: [],
      timeoutMs: 1000,
    });

    assertFailure(result, 'structured_output_invalid');
  });
});

void test('runReactBundleStructuredOutputCaller rejects malformed dependency ref fields before invoking ingress', async () => {
  await withWorkspace(async (workspaceRoot) => {
    let ingressCalled = false;
    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [
        structuredOutput({
          ...DEPENDENCY_REQUEST,
          dependencyRefs: [
            {
              kind: 'esm_import',
              specifier: 42,
              packageName: 'geulbat-runtime-dependency-fixture',
              version: '1.0.0',
              provider: 'explicit_cdn',
              url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
            },
            {
              kind: 'stylesheet',
              packageName: 'geulbat-runtime-dependency-fixture',
              version: '1.0.0',
              provider: 'explicit_cdn',
              url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
            },
          ],
        }),
      ],
      functionCalls: [],
      timeoutMs: 1000,
      runIngress: async () => {
        ingressCalled = true;
        return {
          ok: false,
          reasonCode: 'prepare_failed',
          message: 'malformed structured output reached ingress',
        };
      },
    });

    assertFailure(result, 'structured_output_invalid');
    assert.match(result.message, /dependency specifier/u);
    assert.equal(ingressCalled, false);
  });
});

void test('runReactBundleStructuredOutputCaller redacts path-like diagnostics from ingress failures', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const result = await runReactBundleStructuredOutputCaller({
      workspaceRoot,
      store: createSandboxAttemptStore(),
      structuredOutputs: [structuredOutput(NO_DEPENDENCY_REQUEST)],
      functionCalls: [],
      timeoutMs: 1000,
      runIngress: async () => ({
        ok: false,
        reasonCode: 'acceptance_failed',
        message: 'synthetic failure',
        diagnostics: {
          prepareEvidenceRef: '.geulbat/sandbox-output/private',
          probeEvidenceRef: 'sandbox-output:public-ref',
          underlyingReasonCode: 'prepare_summary_invalid',
        },
      }),
    });

    assertFailure(result, 'acceptance_failed');
    assert.equal(JSON.stringify(result).includes('.geulbat'), false);
    assert.deepEqual(result.diagnostics, {
      probeEvidenceRef: 'sandbox-output:public-ref',
      underlyingReasonCode: 'prepare_summary_invalid',
    });
  });
});
