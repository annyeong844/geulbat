// PTC execute_code pinned SDK projection 검증 — 프로토콜 버전·reserved
// import specifier·mount 불변식·모듈 경로 안전성의 순수 검증만 소유한다.
// 실행 요청(timeout/yield) 검증은 lab-spine 바인딩이 필요해 ingress root
// (execute-code-runtime.ts)에 남는다 — boundary 규칙상 execute-code 요소는
// lab-spine을 직접 import하지 않는다.
import { isAbsolute } from 'node:path';

import {
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
} from '../../lab/session/session-docker-contract.js';
import { PTC_EXECUTE_CODE_RESERVED_SDK_IMPORT_SPECIFIER } from './execute-code-sdk.js';
import {
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeSdkProjection,
} from './execute-code-runtime-contract.js';

export function validatePtcExecuteCodeSdkProjection(
  projection: PtcExecuteCodeRuntimeSdkProjection | undefined,
): { ok: true } | Extract<PtcExecuteCodeRuntimeResult, { ok: false }> {
  if (projection === undefined) {
    return { ok: true };
  }
  if (
    projection.runtimeCompatibilityRange !==
    PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_sdk_protocol_mismatch',
      message:
        'The pinned PTC SDK projection does not match the active callback protocol',
      remediation:
        'Refresh the thread SDK projection and start a new exec before retrying.',
      diagnostics: {
        expectedProtocolVersion: PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
        receivedProtocolVersion: projection.runtimeCompatibilityRange,
      },
    };
  }
  if (
    projection.importSpecifier !==
    PTC_EXECUTE_CODE_RESERVED_SDK_IMPORT_SPECIFIER
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'The pinned PTC SDK projection uses an invalid import specifier',
      remediation:
        'Refresh the thread SDK projection and use the reserved geulbat-sdk import.',
    };
  }
  const mount = projection.mount;
  if (
    !isAbsolute(mount.hostRootPath) ||
    mount.containerRootPath !== PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT ||
    mount.mountPolicyId !== PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID ||
    mount.sdkVersion !== projection.sdkVersion ||
    mount.sdkProjectionHash !== projection.sdkProjectionHash ||
    mount.policyId !== projection.policyId ||
    mount.importSpecifier !== projection.importSpecifier ||
    !isSafePtcSdkModulePath(projection.manifestModule) ||
    !/^sha256:[0-9a-f]{64}$/u.test(projection.manifestSourceHash) ||
    projection.modules.some(
      (module) =>
        !module.specifier.startsWith(`${projection.importSpecifier}/`) ||
        !isSafePtcSdkModulePath(module.modulePath) ||
        !/^sha256:[0-9a-f]{64}$/u.test(module.sourceHash),
    )
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'The pinned PTC SDK projection mount is invalid',
      remediation:
        'Refresh the thread SDK projection before starting a new exec.',
    };
  }
  return { ok: true };
}

function isSafePtcSdkModulePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value
      .split('/')
      .every(
        (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
      )
  );
}
