import test from 'node:test';
import assert from 'node:assert/strict';
import { withRealPtcSessionDockerManager } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import {
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  createPtcExecuteCodeCallbackEffectPolicy,
  createPtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodePlacementBatchRunner,
} from './execute-code-placement.js';
import {
  createPtcExecuteCodeStandbyPool,
  buildPtcExecuteCodeStandbyIdentityKey,
  resolvePtcExecuteCodeStandbyPlacementConfigFromEnv,
  type PtcExecuteCodeStandbyIdentity,
  type PtcExecuteCodeStandbyPool,
} from './execute-code-standby-pool.js';

const identity = {
  threadId: testThreadId(947_1),
  stateRoot: '/workspace',
  trustContextId: 'trust-context',
};

void test('standby config is opt-in and requires both explicit pool bounds', () => {
  assert.equal(
    resolvePtcExecuteCodeStandbyPlacementConfigFromEnv({}),
    undefined,
  );
  assert.deepEqual(
    resolvePtcExecuteCodeStandbyPlacementConfigFromEnv({
      GEULBAT_PTC_STANDBY_ENABLED: 'false',
    }),
    { enabled: false },
  );
  assert.deepEqual(
    resolvePtcExecuteCodeStandbyPlacementConfigFromEnv({
      GEULBAT_PTC_STANDBY_ENABLED: 'true',
      GEULBAT_PTC_STANDBY_READY_TARGET: '3',
      GEULBAT_PTC_STANDBY_MAX_CONCURRENT_REFILLS: '1',
    }),
    { enabled: true, readySlotTarget: 3, maxConcurrentRefills: 1 },
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeStandbyPlacementConfigFromEnv({
        GEULBAT_PTC_STANDBY_READY_TARGET: '1',
      }),
    /GEULBAT_PTC_STANDBY_ENABLED=true/u,
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeStandbyPlacementConfigFromEnv({
        GEULBAT_PTC_STANDBY_ENABLED: 'true',
        GEULBAT_PTC_STANDBY_READY_TARGET: '1',
      }),
    /GEULBAT_PTC_STANDBY_MAX_CONCURRENT_REFILLS/u,
  );
});

void test('standby pool prewarms only to its bound and never reuses a claimed slot', async () => {
  await withRealPtcSessionDockerManager({ identity }, async (fixture) => {
    const pool = createPtcExecuteCodeStandbyPool({
      config: {
        enabled: true,
        readySlotTarget: 2,
        maxConcurrentRefills: 1,
      },
      perIdentityReadyLimit: 2,
      sessionManager: fixture.manager,
    });

    await pool.refill(identity);
    assert.equal(
      fixture.invocations.filter(
        (invocation) => invocation.args[0] === 'create',
      ).length,
      2,
    );

    const first = pool.claimReady(identity);
    const second = pool.claimReady(identity);
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.ephemeralBurstId, second.ephemeralBurstId);
    assert.equal(pool.claimReady(identity), undefined);

    await fixture.manager.close(first);
    await fixture.manager.close(second);
    await pool.refill(identity);
    const replacement = pool.claimReady(identity);
    assert.ok(replacement);
    assert.notEqual(replacement.ephemeralBurstId, first.ephemeralBurstId);
    assert.notEqual(replacement.ephemeralBurstId, second.ephemeralBurstId);
    await fixture.manager.close(replacement);

    assert.deepEqual(await pool.close(), { ok: true, value: undefined });
    assert.deepEqual(await fixture.manager.closeAll(), {
      ok: true,
      value: undefined,
    });
  });
});

void test('standby slots are claimable by another thread without changing their one-shot identity', async () => {
  const childIdentity = {
    ...identity,
    threadId: testThreadId(947_2),
  };
  await withRealPtcSessionDockerManager({ identity }, async (fixture) => {
    const pool = createPtcExecuteCodeStandbyPool({
      config: {
        enabled: true,
        readySlotTarget: 1,
        maxConcurrentRefills: 1,
      },
      perIdentityReadyLimit: 1,
      sessionManager: fixture.manager,
    });

    await pool.refill(identity);
    const claimed = pool.claimReady(childIdentity);
    assert.ok(claimed);
    assert.equal(claimed.threadId, childIdentity.threadId);
    assert.ok(claimed.ephemeralBurstId);

    const restored = await fixture.manager.getOrCreate(claimed);
    assert.equal(restored.ok, true);
    assert.equal(
      fixture.invocations.filter(
        (invocation) => invocation.args[0] === 'create',
      ).length,
      1,
    );

    await fixture.manager.close(claimed);
    assert.deepEqual(await pool.close(), { ok: true, value: undefined });
    assert.deepEqual(await fixture.manager.closeAll(), {
      ok: true,
      value: undefined,
    });
  });
});

void test('standby identity key includes the pinned SDK projection', () => {
  const sdkIdentity: PtcSessionDockerIdentity = {
    ...identity,
    sdkProjectionMount: {
      hostRootPath: '/private/tool-library/projections/sha256-a',
      containerRootPath: PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
      mountPolicyId: PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
      sdkVersion: 'geulbat-tool-library-sdk-v1',
      sdkProjectionHash:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      policyId: 'ptc-sdk-read-tools-v1',
      importSpecifier: 'geulbat-sdk',
    },
  };
  const sdkMount = sdkIdentity.sdkProjectionMount;
  assert.ok(sdkMount);
  const driftedIdentity: PtcSessionDockerIdentity = {
    ...sdkIdentity,
    sdkProjectionMount: {
      ...sdkMount,
      sdkProjectionHash:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  };
  assert.notEqual(
    buildPtcExecuteCodeStandbyIdentityKey(sdkIdentity),
    buildPtcExecuteCodeStandbyIdentityKey(driftedIdentity),
  );
});

void test('standby refill and claim preserve the pinned SDK projection mount', async () => {
  const sdkIdentity: PtcSessionDockerIdentity = {
    ...identity,
    sdkProjectionMount: {
      hostRootPath: '/private/tool-library/projections/sha256-a',
      containerRootPath: PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
      mountPolicyId: PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
      sdkVersion: 'geulbat-tool-library-sdk-v1',
      sdkProjectionHash:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      policyId: 'ptc-sdk-read-tools-v1',
      importSpecifier: 'geulbat-sdk',
    },
  };

  await withRealPtcSessionDockerManager(
    { identity: sdkIdentity },
    async (fixture) => {
      const pool = createPtcExecuteCodeStandbyPool({
        config: {
          enabled: true,
          readySlotTarget: 1,
          maxConcurrentRefills: 1,
        },
        perIdentityReadyLimit: 1,
        sessionManager: fixture.manager,
      });

      await pool.refill(sdkIdentity);
      const createInvocation = fixture.invocations.find(
        (invocation) => invocation.args[0] === 'create',
      );
      assert.ok(createInvocation);
      assert.ok(
        createInvocation.args.includes(
          `type=bind,src=${sdkIdentity.sdkProjectionMount?.hostRootPath},dst=${PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT},readonly`,
        ),
      );

      const claimed = pool.claimReady(sdkIdentity);
      assert.ok(claimed);
      assert.deepEqual(
        claimed.sdkProjectionMount,
        sdkIdentity.sdkProjectionMount,
      );

      await fixture.manager.close(claimed);
      await pool.refill(sdkIdentity);
      assert.deepEqual(await pool.close(), { ok: true, value: undefined });
      assert.deepEqual(await fixture.manager.closeAll(), {
        ok: true,
        value: undefined,
      });
    },
  );
});

void test('standby shutdown waits for an in-flight refill and destroys the late slot', async () => {
  let markCreateStarted: (() => void) | undefined;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  let finishCreate:
    | ((result: PtcSessionDockerCommandResult) => void)
    | undefined;
  const createResult = new Promise<PtcSessionDockerCommandResult>((resolve) => {
    finishCreate = resolve;
  });

  await withRealPtcSessionDockerManager(
    {
      identity,
      commandResult(invocation) {
        if (invocation.args[0] !== 'create') {
          return undefined;
        }
        markCreateStarted?.();
        return createResult;
      },
    },
    async (fixture) => {
      const pool = createPtcExecuteCodeStandbyPool({
        config: {
          enabled: true,
          readySlotTarget: 1,
          maxConcurrentRefills: 1,
        },
        perIdentityReadyLimit: 1,
        sessionManager: fixture.manager,
      });

      const refill = pool.refill(identity);
      await createStarted;
      let closeSettled = false;
      const close = pool.close().then((result) => {
        closeSettled = true;
        return result;
      });
      await Promise.resolve();
      assert.equal(closeSettled, false);

      assert.ok(finishCreate);
      finishCreate({
        kind: 'exit',
        exitCode: 0,
        stdout: `${fixture.containerId}\n`,
        stderr: '',
      });
      await refill;
      assert.deepEqual(await close, { ok: true, value: undefined });
      assert.equal(
        fixture.invocations.filter((invocation) => invocation.args[0] === 'rm')
          .length,
        1,
      );
      assert.equal(pool.claimReady(identity), undefined);
      assert.deepEqual(await fixture.manager.closeAll(), {
        ok: true,
        value: undefined,
      });
    },
  );
});

void test('placement does not prewarm a standby when measured memory cannot hold it beside main', async () => {
  let createCount = 0;
  const sessionManager = {
    async getOrCreate() {
      createCount += 1;
      return {
        ok: false,
        reasonCode: 'container_create_failed',
        message: 'unexpected standby create',
      } as const;
    },
    async close() {
      return { ok: true, value: undefined } as const;
    },
    async closeAll() {
      return { ok: true, value: undefined } as const;
    },
  } satisfies PtcSessionDockerManager;
  const pool = createPtcExecuteCodeStandbyPool({
    config: {
      enabled: true,
      readySlotTarget: 2,
      maxConcurrentRefills: 2,
    },
    perIdentityReadyLimit: 2,
    sessionManager,
  });
  const batchRunner = {
    async runPtcLabSessionBatchCommand() {
      throw new Error('not used by placement acquisition');
    },
  } satisfies PtcExecuteCodePlacementBatchRunner;
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    placementResourceBudgetProvider: () => ({
      resourceSnapshotRef: {
        snapshotId: 'standby-insufficient-capacity',
        source: 'agent_resource_budget_provider',
      },
      availableParallelism: { ok: true, value: 2 },
      constrainedMemoryBytes: { ok: true, value: 1 },
      availableMemoryBytes: { ok: true, value: 1 },
    }),
    resourceRequirements: { cpuUnits: 1, memoryBytes: 1 },
    standbyPool: pool,
  });

  const warm = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity: classifyPtcExecuteCodePlacementContinuity(),
    callbackEffectPolicy: createPtcExecuteCodeCallbackEffectPolicy({
      callbackToolCount: 0,
    }),
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(warm.ok && !('queued' in warm), true);
  await Promise.resolve();
  assert.equal(createCount, 0);

  if (warm.ok && !('queued' in warm)) {
    await coordinator.releasePlacement(warm.value);
  }
  assert.deepEqual(await coordinator.reapPlacements?.(), { ok: true });
});

void test('placement claims a ready standby first and falls through cold when the pool is dry', async () => {
  const readyIdentity: PtcExecuteCodeStandbyIdentity = {
    ...identity,
    ephemeralBurstId: 'ptc_burst_ready_once',
  };
  let ready: PtcExecuteCodeStandbyIdentity | undefined = readyIdentity;
  const standbyPool = {
    async refill() {},
    claimReady() {
      const claimed = ready;
      ready = undefined;
      return claimed;
    },
    readInventory() {
      const readySlotCount = ready === undefined ? 0 : 1;
      return { readySlotCount, reservedSlotCount: readySlotCount };
    },
    async close() {
      return { ok: true, value: undefined } as const;
    },
  } satisfies PtcExecuteCodeStandbyPool;
  const closed: string[] = [];
  const sessionManager = {
    async getOrCreate() {
      throw new Error('not used by placement acquisition');
    },
    async close(closedIdentity) {
      if (closedIdentity.ephemeralBurstId !== undefined) {
        closed.push(closedIdentity.ephemeralBurstId);
      }
      return { ok: true, value: undefined } as const;
    },
    async closeAll() {
      return { ok: true, value: undefined } as const;
    },
  } satisfies PtcSessionDockerManager;
  const batchRunner = {
    async runPtcLabSessionBatchCommand() {
      throw new Error('not used by placement acquisition');
    },
  } satisfies PtcExecuteCodePlacementBatchRunner;
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    placementResourceBudgetProvider: () => ({
      resourceSnapshotRef: {
        snapshotId: 'standby-test-capacity',
        source: 'agent_resource_budget_provider',
      },
      availableParallelism: { ok: true, value: 3 },
      constrainedMemoryBytes: { ok: true, value: 3 },
      availableMemoryBytes: { ok: true, value: 3 },
    }),
    resourceRequirements: { cpuUnits: 1, memoryBytes: 1 },
    standbyPool,
  });
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 1,
  });
  const warm = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity: classifyPtcExecuteCodePlacementContinuity(),
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(warm.ok, true);
  if (!warm.ok || 'queued' in warm) {
    return;
  }

  const independent = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'read_only_analysis' },
  });
  const firstBurst = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity: independent,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  const secondBurst = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity: independent,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(firstBurst.ok, true);
  assert.equal(secondBurst.ok, true);
  if (
    !firstBurst.ok ||
    'queued' in firstBurst ||
    !secondBurst.ok ||
    'queued' in secondBurst ||
    firstBurst.value.kind !== 'burst' ||
    secondBurst.value.kind !== 'burst'
  ) {
    return;
  }
  assert.equal(firstBurst.value.provisioning, 'standbyRestore');
  assert.equal(
    firstBurst.value.identity.ephemeralBurstId,
    readyIdentity.ephemeralBurstId,
  );
  assert.equal(secondBurst.value.provisioning, 'coldCreate');
  assert.notEqual(
    secondBurst.value.identity.ephemeralBurstId,
    readyIdentity.ephemeralBurstId,
  );

  await coordinator.releasePlacement(firstBurst.value);
  await coordinator.releasePlacement(secondBurst.value);
  await coordinator.releasePlacement(warm.value);
  assert.deepEqual(
    closed.sort(),
    [
      firstBurst.value.identity.ephemeralBurstId,
      secondBurst.value.identity.ephemeralBurstId,
    ].sort(),
  );
  assert.deepEqual(await coordinator.reapPlacements?.(), { ok: true });
});

void test('runtime standby pool is rejected without the burst capability owner', async () => {
  const { createPtcExecuteCodeRuntime } =
    await import('./execute-code-runtime.js');
  assert.throws(
    () =>
      createPtcExecuteCodeRuntime({
        burstPlacement: undefined,
        standbyPlacement: {
          enabled: true,
          readySlotTarget: 1,
          maxConcurrentRefills: 1,
        },
      }),
    /standby placement requires burst placement/u,
  );
});
