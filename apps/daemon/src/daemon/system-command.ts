import type { HostCommandRuntime } from '../command-host/contract.js';
import { SYSTEM_SESSION_OWNER } from './host-command-output-store.js';

// 데몬 자신이 부르는 명령(git·docker CLI처럼 제품 기능의 뒷일)을 command-host
// 세션으로 돌린다 — 데몬이 자식을 직접 소유하지 않게 하는 경로다.
//
// 도구가 쓰는 exec_command와 다른 점은 소유자뿐이다: 이 세션은 스레드가 아니라
// 데몬의 것이므로 정원 64를 쓰지 않고 스레드 열거에도 나타나지 않는다(P7.6
// §5.1·§5.3). 출력이 inline 예산 안이면 디스크는 한 번도 닿지 않는다(§4.2).

interface SystemCommandResult {
  /** 정상 종료면 종료코드, 시그널·미종료면 null. */
  exitCode: number | null;
  status: string;
  stdout: string;
  stderr: string;
}

export async function runSystemCommand(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** 회수해 올 출력의 상한 — 세션의 inline 예산 이하여야 한다. */
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<SystemCommandResult> {
  const started = await args.hostCommands.start({
    executable: args.executable,
    args: [...args.args],
    cwd: args.cwd ?? args.stateRoot,
    env: args.env,
    stateRoot: args.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    runId: 'system',
    callId: 'system',
    stdinMode: 'closed',
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!started.ok) {
    throw new Error(
      `system command could not start (${args.executable}): ${started.message}`,
    );
  }

  const settled = await args.hostCommands.waitForInitialResult({
    stateRoot: args.stateRoot,
    outputRef: started.outputRef,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!settled.ok) {
    throw new Error(
      `system command did not settle (${args.executable}): ${settled.message}`,
    );
  }
  let snapshot = settled.value;
  while (snapshot.status === 'running') {
    // waitForInitialResult의 대기 ceiling은 한 RPC가 데몬 턴을 영원히 붙들지
    // 않게 할 뿐, system command의 완료 의미를 잘라서는 안 된다. native
    // picker처럼 사람을 기다리는 명령도 임의 timeout 없이 terminal 사건에
    // 다시 합류한다.
    const observed = await args.hostCommands.interact({
      stateRoot: args.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: started.outputRef,
      afterRevision: snapshot.revision,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!observed.ok) {
      throw new Error(
        `system command did not settle (${args.executable}): ${observed.message}`,
      );
    }
    snapshot = observed.value.snapshot;
  }

  // 작은 결과는 스냅샷이 그대로 나른다(디스크 0회). 큰 결과만 ref로 되돌아오며,
  // 그때는 우리가 요구한 상한만큼만 읽는다 — 내부 명령의 출력은 증거가 아니라
  // 판정 재료이므로 무한히 모으지 않는다.
  const stdout =
    snapshot.stdout ??
    (await readStream(args, started.outputRef, 'stdout', snapshot.outputRef));
  const stderr =
    snapshot.stderr ??
    (await readStream(args, started.outputRef, 'stderr', snapshot.outputRef));
  return {
    exitCode: snapshot.exitCode,
    status: snapshot.status,
    stdout,
    stderr,
  };
}

async function readStream(
  args: {
    hostCommands: HostCommandRuntime;
    stateRoot: string;
    maxOutputBytes: number;
    signal?: AbortSignal;
  },
  outputRef: string,
  stream: 'stdout' | 'stderr',
  retainedRef: string | null,
): Promise<string> {
  if (retainedRef === null) {
    throw new Error(`system command ${stream} output reference is missing.`);
  }
  const result = await args.hostCommands.interact({
    stateRoot: args.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    outputRef,
    yieldTimeMs: 0,
    page: { stream, offsetBytes: 0, limitBytes: args.maxOutputBytes },
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!result.ok) {
    throw new Error(
      `system command ${stream} recovery failed: ${result.message}`,
    );
  }
  const page = result.value.page;
  if (page === null) {
    throw new Error(`system command ${stream} output page is missing.`);
  }
  if (page.nextOffsetBytes !== null) {
    throw new Error(
      `system command ${stream} output exceeds the configured recovery limit of ${args.maxOutputBytes} bytes.`,
    );
  }
  return page.content;
}
