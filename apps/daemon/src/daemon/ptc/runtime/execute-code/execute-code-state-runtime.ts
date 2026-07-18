// PTC execute_code state-runtime 배선 빌더 — state root 하나에 묶이는
// 하위 런타임 묶음(세션 매니저·standby 풀·batch runner·placement
// coordinator·store)의 구성을 소유한다. composition root
// (execute-code-runtime.ts)는 셧다운 가드·canonical 해석·메모이즈만 갖고
// 구성은 여기로 위임한다 — 구성 전용 import 엣지가 이 모듈로 이동해
// composition root의 fan-out을 줄인다. 역참조(순환) 금지: 이 모듈은
// execute-code-runtime.ts를 import하지 않는다.
import { join } from 'node:path';

import { definedPtcProps } from '../../shared/record-shape.js';
import { createPtcLabSessionBatchCommandRunner } from '../../lab/shell/lab-session-batch-command.js';
import { createPtcSessionDockerManager } from '../../lab/session/session-docker.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  createPtcSessionDockerOpenNetworkPackageInstallPolicy,
  resolvePtcSessionDockerResourceRequirements,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import type { PtcExecuteCodePackageInstallRuntimeConfig } from './execute-code-package-install-config.js';
import { createPtcExecuteCodePlacementCoordinator } from './execute-code-placement.js';
import type {
  PtcExecuteCodeBurstPlacementConfig,
  PtcExecuteCodePlacementCoordinator,
} from './execute-code-placement-contract.js';
import {
  createPtcExecuteCodeStandbyPool,
  type PtcExecuteCodeStandbyPlacementConfig,
} from './execute-code-standby-pool.js';
import {
  createPtcExecuteCodeStore,
  type PtcExecuteCodeStore,
  type PtcExecuteCodeStoreRuntimeConfig,
} from './execute-code-store.js';
import type { PtcExecuteCodePlacementResourceBudget } from './execute-code-runtime-contract.js';

export type CreatePtcSessionDockerManager =
  typeof createPtcSessionDockerManager;
export type CreatePtcLabSessionBatchCommandRunner =
  typeof createPtcLabSessionBatchCommandRunner;
export type CreatePtcExecuteCodePlacementCoordinator =
  typeof createPtcExecuteCodePlacementCoordinator;
export type CreatePtcExecuteCodeStandbyPool =
  typeof createPtcExecuteCodeStandbyPool;

export interface ExecuteCodeStateRuntime {
  canonicalStateRoot: string;
  runtimeRoot: string;
  sessionManager: PtcSessionDockerManager;
  batchRunner: ReturnType<CreatePtcLabSessionBatchCommandRunner>;
  placementCoordinator: PtcExecuteCodePlacementCoordinator;
  store?: PtcExecuteCodeStore;
}

// CreatePtcExecuteCodeRuntimeOptions(composition root 소유)에서 구성이
// 실제로 읽는 DI/경로 필드만 — 전체 옵션 객체가 구조적으로 충족한다.
interface PtcExecuteCodeStateRuntimeWiringOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcSessionDockerManager;
  createBatchCommandRunner?: CreatePtcLabSessionBatchCommandRunner;
  createPlacementCoordinator?: CreatePtcExecuteCodePlacementCoordinator;
  createStandbyPool?: CreatePtcExecuteCodeStandbyPool;
  placementResourceBudgetProvider?: () => PtcExecuteCodePlacementResourceBudget;
  storeRootForState?: (stateRoot: string) => string;
}

export function buildPtcExecuteCodeStateRuntime(args: {
  canonicalStateRoot: string;
  // 경로 해석(resolvePtcRuntimeRoot)은 composition root 소유 — boundary 규칙상
  // execute-code 요소는 runtime-common을 직접 import하지 않는다.
  runtimeRoot: string;
  options: PtcExecuteCodeStateRuntimeWiringOptions;
  packageInstallConfig:
    | Extract<PtcExecuteCodePackageInstallRuntimeConfig, { enabled: true }>
    | undefined;
  burstPlacementConfig: PtcExecuteCodeBurstPlacementConfig | undefined;
  standbyPlacementConfig:
    | Extract<PtcExecuteCodeStandbyPlacementConfig, { enabled: true }>
    | undefined;
  storeConfig:
    | Extract<PtcExecuteCodeStoreRuntimeConfig, { enabled: true }>
    | undefined;
}): ExecuteCodeStateRuntime {
  const {
    canonicalStateRoot,
    runtimeRoot,
    options,
    packageInstallConfig,
    burstPlacementConfig,
    standbyPlacementConfig,
    storeConfig,
  } = args;
  const createSessionManager =
    options.createSessionManager ?? createPtcSessionDockerManager;
  const sessionPolicy =
    packageInstallConfig === undefined
      ? createPtcSessionDockerLocalBatchCommandPolicy()
      : createPtcSessionDockerOpenNetworkPackageInstallPolicy({
          tmpTmpfsSize: packageInstallConfig.tmpTmpfsSize,
        });
  const managerArgs: Parameters<CreatePtcSessionDockerManager>[0] = {
    runtimeRoot,
    policy: sessionPolicy,
    realpathStateRoot: async () => canonicalStateRoot,
    ...(burstPlacementConfig === undefined
      ? {}
      : { reapEphemeralOnFirstUse: true }),
    ...definedPtcProps({
      dockerPath: options.dockerPath,
      commandRunner: options.commandRunner,
    }),
  };

  const sessionManager = createSessionManager(managerArgs);
  const standbyPool =
    standbyPlacementConfig === undefined || burstPlacementConfig === undefined
      ? undefined
      : (options.createStandbyPool ?? createPtcExecuteCodeStandbyPool)({
          config: standbyPlacementConfig,
          perIdentityReadyLimit: standbyPlacementConfig.readySlotTarget,
          sessionManager,
        });
  const createBatchCommandRunner =
    options.createBatchCommandRunner ?? createPtcLabSessionBatchCommandRunner;
  const createPlacementCoordinator =
    options.createPlacementCoordinator ??
    createPtcExecuteCodePlacementCoordinator;
  return {
    canonicalStateRoot,
    runtimeRoot,
    sessionManager,
    batchRunner: createBatchCommandRunner({ sessionManager }),
    placementCoordinator: createPlacementCoordinator({
      ...(burstPlacementConfig === undefined
        ? {}
        : {
            burstConfig: burstPlacementConfig,
            placementResourceBudgetProvider:
              options.placementResourceBudgetProvider,
            resourceRequirements:
              resolvePtcSessionDockerResourceRequirements(sessionPolicy),
          }),
      ...(standbyPool === undefined ? {} : { standbyPool }),
    }),
    ...(storeConfig === undefined
      ? {}
      : {
          store: createPtcExecuteCodeStore({
            rootDir:
              options.storeRootForState?.(canonicalStateRoot) ??
              join(canonicalStateRoot, '.geulbat', 'ptc', 'store'),
            config: storeConfig,
          }),
        }),
  };
}
