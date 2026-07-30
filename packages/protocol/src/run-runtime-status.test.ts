import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProviderRequestDiagnostics,
  isProviderRuntimeStatusEventPayload,
  isRunUsageTotals,
  isSubagentRuntimeDiagnostics,
} from './run-runtime-status.js';

void test('provider runtime status distinguishes response, auth, and rate-limit waits', () => {
  const providerWaiting = {
    phase: 'provider_waiting',
    observedAt: '2026-07-23T11:30:00.000Z',
  } as const;
  const authWaiting = {
    phase: 'auth_waiting',
    observedAt: '2026-07-23T11:30:00.500Z',
  } as const;
  const rateLimitWaiting = {
    phase: 'rate_limit_waiting',
    observedAt: '2026-07-23T11:30:01.000Z',
  } as const;

  assert.equal(isProviderRuntimeStatusEventPayload(providerWaiting), true);
  assert.equal(isProviderRuntimeStatusEventPayload(authWaiting), true);
  assert.equal(isProviderRuntimeStatusEventPayload(rateLimitWaiting), true);
  assert.equal(
    isProviderRuntimeStatusEventPayload({
      ...rateLimitWaiting,
      phase: 'thinking',
    }),
    false,
  );
  assert.equal(
    isProviderRuntimeStatusEventPayload({
      ...rateLimitWaiting,
      observedAt: 'later',
    }),
    false,
  );
});

void test('provider request diagnostics preserve timing and factual retry outcome', () => {
  const request = {
    startedAt: '2026-07-23T11:30:00.000Z',
    lastEventAt: '2026-07-23T11:30:02.000Z',
    endedAt: '2026-07-23T11:30:03.000Z',
    durationMs: 3_000,
    attemptCount: 2,
    retry: {
      available: false,
      performed: true,
      outcome: 'recovered',
      retryAfterMs: 2_500,
    },
  } as const;

  assert.equal(isProviderRequestDiagnostics(request), true);
  assert.equal(
    isProviderRuntimeStatusEventPayload({
      phase: 'provider_streaming',
      observedAt: request.endedAt,
      request,
    }),
    true,
  );
  assert.equal(
    isProviderRequestDiagnostics({
      ...request,
      attemptCount: 0,
    }),
    false,
  );
  assert.equal(
    isProviderRequestDiagnostics({
      ...request,
      endedAt: undefined,
    }),
    false,
  );
  assert.equal(
    isProviderRequestDiagnostics({
      ...request,
      retry: {
        available: true,
        performed: false,
        outcome: 'scheduled',
      },
    }),
    false,
  );
  assert.equal(
    isProviderRequestDiagnostics({
      ...request,
      retry: {
        available: true,
        performed: true,
        outcome: 'scheduled',
        retryAfterMs: -1,
      },
    }),
    false,
  );
});

void test('subagent runtime and usage guards validate their complete shared wire shapes', () => {
  const runtime = {
    phase: 'tool_running',
    observedAt: '2026-07-23T11:30:03.000Z',
    partialOutputAvailable: true,
    previousChildRunId: 'run-child-previous',
    providerRequest: {
      startedAt: '2026-07-23T11:30:00.000Z',
      endedAt: '2026-07-23T11:30:03.000Z',
      durationMs: 3_000,
      attemptCount: 1,
    },
  } as const;

  assert.equal(isSubagentRuntimeDiagnostics(runtime), true);
  assert.equal(
    isSubagentRuntimeDiagnostics({
      ...runtime,
      providerRequest: {
        ...runtime.providerRequest,
        attemptCount: 0,
      },
    }),
    false,
  );
  assert.equal(
    isRunUsageTotals({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
    }),
    true,
  );
  assert.equal(
    isRunUsageTotals({
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 5,
      cachedInputTokens: 2,
    }),
    false,
  );
});
