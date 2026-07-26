import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  buildDockerClientProcessEnv,
  type DockerClientCommandInvocation,
  type DockerClientCommandResult,
  type DockerClientCommandRunner,
} from './docker-client-command.js';
import type { HostCommandSnapshot } from './host-command-output-store.js';
import { runHostRoutedSystemCommand } from './host-routed-command.js';

// P7.6 item 4 (직접 자식 정리) — 데몬이 직접 소유하던 docker 자식을 command-host
// 워커의 system 세션으로 옮긴다. marketplace git과 같은 이동이며(runSystemCommand,
// 커밋 d260c803e), 다른 점은 소비자(react-bundle 의존성 admission)가 docker 결과를
// DockerClientCommandResult(kind 유니온)로 읽는다는 것뿐이다. 그래서 이 어댑터는
// host 스냅샷을 그 계약으로 되돌려, 소비자 코드는 그대로 두고 자식만 데몬 밖으로
// 내보낸다. 실행과 관찰 자체는 host-routed-command.ts가 소유한다.

const DOCKER_CANCELLED_STDERR = 'docker command cancelled';

export function createHostRoutedDockerCommandRunner(deps: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  /**
   * 한 번의 페이지 요청 상한. 세션 inline 예산 이하여야 페이지 읽기가 거부되지
   * 않는다(§4.2 — interact page limitBytes는 inlineMaxBytes 이하여야 한다).
   */
  pageLimitBytes: number;
  /**
   * 회수 상한. docker 출력을 판정 재료로만 쓰는 소비자는 여기서 끊어도 된다
   * (react-bundle — 실제 산출물은 mount 파일이다). 출력 자체가 결과인 소비자
   * (PTC)는 주지 않아 스트림 끝까지 읽고, 상한 초과는 세션 정책이
   * output_limit_exceeded로 막는다.
   */
  maxOutputBytes?: number;
}): DockerClientCommandRunner {
  return (invocation) =>
    runHostRoutedDockerCommand({
      hostCommands: deps.hostCommands,
      stateRoot: deps.stateRoot,
      pageLimitBytes: deps.pageLimitBytes,
      ...(deps.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: deps.maxOutputBytes }),
      invocation,
    });
}

async function runHostRoutedDockerCommand(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  maxOutputBytes?: number;
  invocation: DockerClientCommandInvocation;
}): Promise<DockerClientCommandResult> {
  const {
    hostCommands,
    stateRoot,
    pageLimitBytes,
    maxOutputBytes,
    invocation,
  } = args;
  const observed = await runHostRoutedSystemCommand({
    hostCommands,
    stateRoot,
    pageLimitBytes,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    invocation: {
      executable: invocation.executable,
      args: invocation.args,
      // docker는 mount에 절대경로를 쓰므로 cwd는 무해하다 — 세션 소유 stateRoot로 둔다.
      cwd: stateRoot,
      // 직접 러너와 동일한 allowlist env(DOCKER_HOST 등)만 넘긴다.
      env: buildDockerClientProcessEnv(),
      // PTC처럼 출력 자체가 결과인 capless 소비자는 stdout/stderr 모두 축출 없는
      // lossless ring을 쓰고, 둘을 끝까지 페이지로 비운다. 진단만 읽는
      // react-bundle 소비자는 기존 tail 의미를 유지한다.
      streamMode: maxOutputBytes === undefined ? 'lossless' : 'tail',
      ...(invocation.timeoutMs === undefined
        ? {}
        : { timeoutMs: invocation.timeoutMs }),
      // 호출자가 출력 상한을 요구할 때만 세션에 건다 — react-bundle은 걸지 않으므로
      // 그때는 세션 기본 tail 링을 쓰고, 진단 상한만큼만 회수한다.
      ...(invocation.outputBufferPolicy === undefined
        ? {}
        : {
            maxOutputBytesPerStream:
              invocation.outputBufferPolicy.maxBufferedBytesPerStream,
          }),
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
    },
  });
  if (!observed.ok) {
    return observed.aborted
      ? { kind: 'cancelled', stdout: '', stderr: DOCKER_CANCELLED_STDERR }
      : { kind: 'crash', stdout: '', stderr: observed.message };
  }
  return mapSnapshotToResult(
    observed.snapshot,
    observed.stdout,
    observed.stderr,
    invocation.outputBufferPolicy?.maxBufferedBytesPerStream ??
      maxOutputBytes ??
      pageLimitBytes,
  );
}

function mapSnapshotToResult(
  snapshot: HostCommandSnapshot,
  stdout: string,
  stderr: string,
  /** 스냅샷이 상한을 보고하지 않을 때 되돌릴 값 — 호출자가 건 상한이 먼저다. */
  reportedMaxBufferedBytesPerStream: number,
): DockerClientCommandResult {
  // command-host status는 DockerClientCommandResult kind와 거의 동명이라 그대로
  // 되돌린다. 소비자(react-bundle)는 kind로 docker 가용성을 판정한다.
  switch (snapshot.status) {
    case 'exit':
      return { kind: 'exit', exitCode: snapshot.exitCode ?? 1, stdout, stderr };
    case 'timeout':
      return { kind: 'timeout', stdout, stderr };
    case 'cancelled':
      return { kind: 'cancelled', stdout, stderr };
    case 'output_limit_exceeded':
      return {
        kind: 'output_limit_exceeded',
        stdout,
        stderr,
        stream: snapshot.outputLimitExceeded?.stream ?? 'stdout',
        maxBufferedBytesPerStream:
          snapshot.outputLimitExceeded?.maxOutputBytesPerStream ??
          reportedMaxBufferedBytesPerStream,
      };
    // 남은 상태는 모두 비정상 종료다 — 직접 러너의 crash와 같게, 진단이 비면
    // 어떤 상태였는지만 남긴다. 'running'은 위 대기가 끝난 뒤엔 오지 않지만
    // 유니온 전수 처리를 위해 함께 둔다.
    case 'running':
    case 'crash':
    case 'signal':
    case 'output_store_failed':
    case 'daemon_shutdown':
    case 'daemon_restart_interrupted':
    case 'command_host_interrupted':
      return {
        kind: 'crash',
        stdout,
        stderr:
          stderr === ''
            ? `docker command terminated (${snapshot.status})`
            : stderr,
      };
  }
}
