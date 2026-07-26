import type { HostCommandRuntime } from '../command-host/contract.js';
import type {
  ComputerSessionDiscoveryCommandInvocation,
  ComputerSessionDiscoveryCommandResult,
  ComputerSessionDiscoveryCommandRunnerAsync,
} from './files/computer-session-defaults.js';
import { runHostRoutedSystemCommand } from './host-routed-command.js';

// P7.6 item 4 — 조립이 내부 명령의 실행 위치를 정한다(boundaries: daemon-composition).
// 브라우즈 위치 발견이 부르는 PowerShell/osascript는 데몬의 자식이 아니라 command-host
// 워커의 system 세션에서 돈다. 데몬 부팅 직후와 재시도마다 도는 외부 명령이라
// "데몬은 자기 이유로만 죽는다"를 지키려면 이 자식이 데몬 밖에 있어야 한다.
//
// 매핑이 여기 있는 이유: 발견 결과 계약({error,status,stdout})은 daemon-files의 것이고
// 실행 계층(daemon-process-execution)은 그것을 볼 수 없다. 두 층을 함께 볼 수 있는
// 곳은 조립이므로, 어느 쪽 경계도 열지 않고 이 seam이 번역을 맡는다.
//
// windowsHide는 세션 자식이 이미 항상 숨김으로 뜨므로(spawn-gate) 넘길 것이 없다.
export function createHostRoutedComputerSessionDiscoveryCommandRunner(deps: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  /** 세션의 inline 예산 — 페이지 읽기 상한이 이 값을 넘으면 거부된다(§4.2). */
  inlineMaxBytes: number;
}): ComputerSessionDiscoveryCommandRunnerAsync {
  return async (invocation) => {
    const observed = await runHostRoutedSystemCommand({
      hostCommands: deps.hostCommands,
      stateRoot: deps.stateRoot,
      // 발견 출력은 파서가 전부 읽어야 하는 결과다. 호출자의 상한(maxBufferBytes)이
      // 세션 inline 예산보다 클 수 있으므로 페이지는 예산 단위로 요청하고 상한까지
      // 이어 읽는다 — 성공한 출력이 잘려 파서가 실패하면 발견이 헛돌게 된다.
      maxOutputBytes: invocation.maxBufferBytes,
      pageLimitBytes: Math.min(invocation.maxBufferBytes, deps.inlineMaxBytes),
      invocation: {
        executable: invocation.executable,
        args: invocation.args,
        // 발견은 경로를 인자로 받지 않고 OS에게 묻는다 — cwd는 세션이 사는 곳으로 둔다.
        cwd: deps.stateRoot,
        // 지금까지 execFile은 데몬 환경을 그대로 상속했다. PowerShell 탐색은
        // SystemRoot·PATH 같은 값에 의존하므로 그 동작을 유지한다.
        env: process.env,
        timeoutMs: invocation.timeoutMs,
        // execFile의 maxBuffer 초과가 error였던 것처럼, 세션 상한 초과도 실패다.
        maxOutputBytesPerStream: invocation.maxBufferBytes,
      },
    });
    return mapObservationToDiscoveryResult(invocation, observed);
  };
}

function mapObservationToDiscoveryResult(
  invocation: ComputerSessionDiscoveryCommandInvocation,
  observed: Awaited<ReturnType<typeof runHostRoutedSystemCommand>>,
): ComputerSessionDiscoveryCommandResult {
  // 발견 계약은 성공을 status 0으로만 인정하고(§computer-browse-discovery),
  // 실패는 error로 보고된 뒤 백오프 재시도된다. 그래서 정상 종료가 아닌 모든
  // 상태는 status를 남기지 않고 error로 접는다 — 부분 stdout으로 파서를 태우면
  // "일시 실패가 영구 기능 상실"이 되던 그 회귀로 돌아간다.
  if (!observed.ok) {
    return {
      error: new Error(
        `${invocation.executable} discovery command could not run: ${observed.message}`,
      ),
      status: null,
      stdout: '',
    };
  }
  if (observed.snapshot.status === 'exit' && observed.snapshot.exitCode === 0) {
    return { error: undefined, status: 0, stdout: observed.stdout };
  }
  const detail =
    observed.snapshot.status === 'exit'
      ? `exited with code ${String(observed.snapshot.exitCode)}`
      : `terminated (${observed.snapshot.status})`;
  return {
    error: new Error(`${invocation.executable} discovery command ${detail}`),
    status: null,
    stdout: observed.stdout,
  };
}
