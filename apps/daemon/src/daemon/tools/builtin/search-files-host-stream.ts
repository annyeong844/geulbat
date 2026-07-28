import type { HostCommandRuntime } from '../../../command-host/contract.js';
import {
  SYSTEM_SESSION_OWNER,
  type HostCommandSnapshot,
} from '../../host-command-output-store.js';

export interface SearchFilesHostRouting {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
}

// P7.6 item 4 (직접 자식 정리) — search_files가 낳는 검색 자식(ripgrep 등)을 데몬의
// 자식이 아니라 command-host 워커의 system 세션에서 돌린다. docker·git처럼 결과를
// 한 번에 받는 배치가 아니라 줄 단위로 흐르는 스트림이므로, 여기서는 세션을
// `protocol` 모드로 열고 읽은 만큼만 놓아준다(P7.5 §5.2).
//
// `tail` 모드를 쓰지 않는 이유: 예산을 넘으면 앞을 버리기 때문이다. 검색 출력은
// 줄 단위 프레임(ripgrep --json)이라 한 바이트가 사라지면 그 줄의 일치를 조용히
// 잃는다. `protocol` 모드는 버리지 않고 읽는 쪽이 따라올 때까지 소스를 멈추므로,
// 데몬 안에서 직접 파이프를 읽던 지금의 무손실 성질이 유지된다.
//
// 세션은 system 소유다 — 검색 자식은 모델이 보는 명령이 아니라 도구의 구현 수단이라
// 스레드 정원(§5.1)을 쓰거나 스레드 세션 열거에 나타나서는 안 된다.

interface HostRoutedCommandStreamOutcome {
  status: HostCommandSnapshot['status'];
  exitCode: number | null;
  stderr: string;
}

type StreamName = 'stdout' | 'stderr';

export async function streamHostRoutedCommandLines(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  executable: string;
  commandArgs: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 한 번의 페이지 요청 상한 — 세션 inline 예산 이하여야 한다(§4.2). */
  pageLimitBytes: number;
  /** 도착한 stdout 조각. 프레이밍은 호출자가 정한다(줄바꿈·NUL). */
  onStdoutChunk: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; value: HostRoutedCommandStreamOutcome }
  | { ok: false; aborted: boolean; message: string }
> {
  const { hostCommands, stateRoot, pageLimitBytes, signal } = args;
  if (signal?.aborted === true) {
    return {
      ok: false,
      aborted: true,
      message: 'search command aborted before start',
    };
  }

  const started = await hostCommands.start({
    executable: args.executable,
    args: [...args.commandArgs],
    cwd: args.cwd,
    env: args.env,
    stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    streamMode: 'protocol',
    runId: 'system',
    callId: 'system',
    stdinMode: 'closed',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!started.ok) {
    return { ok: false, aborted: false, message: started.message };
  }
  const outputRef = started.outputRef;
  let terminalObserved = false;

  const terminateClaimedSession = async (): Promise<void> => {
    let terminated = await hostCommands.interact({
      stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef,
      terminate: true,
      yieldTimeMs: 0,
    });
    if (!terminated.ok) {
      if (
        terminated.reasonCode === 'not_found' ||
        terminated.reasonCode === 'not_running'
      ) {
        return;
      }
      throw new Error(`search command cleanup failed: ${terminated.message}`);
    }
    while (terminated.value.snapshot.status === 'running') {
      terminated = await hostCommands.interact({
        stateRoot,
        threadId: SYSTEM_SESSION_OWNER,
        owner: 'system',
        outputRef,
        afterRevision: terminated.value.snapshot.revision,
      });
      if (!terminated.ok) {
        if (
          terminated.reasonCode === 'not_found' ||
          terminated.reasonCode === 'not_running'
        ) {
          return;
        }
        throw new Error(`search command cleanup failed: ${terminated.message}`);
      }
    }
  };

  try {
    // claim해야 데몬 연결과 무관하게 세션이 살아 있고, 첫 스냅샷으로 상태를 얻는다.
    const initial = await hostCommands.waitForInitialResult({
      stateRoot,
      outputRef,
      yieldTimeMs: 0,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!initial.ok) {
      return {
        ok: false,
        aborted: initial.reasonCode === 'wait_aborted',
        message: initial.message,
      };
    }

    const readOffsets: Record<StreamName, number> = { stdout: 0, stderr: 0 };
    let stderr = '';
    let snapshot = initial.value;

    const drain = async (
      stream: StreamName,
    ): Promise<
      | { ok: true; hasMore: boolean }
      | { ok: false; aborted: boolean; message: string }
    > => {
      const observed = await hostCommands.interact({
        stateRoot,
        threadId: SYSTEM_SESSION_OWNER,
        owner: 'system',
        outputRef,
        yieldTimeMs: 0,
        page: {
          stream,
          offsetBytes: readOffsets[stream],
          limitBytes: pageLimitBytes,
        },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!observed.ok) {
        return {
          ok: false,
          aborted: observed.reasonCode === 'wait_aborted',
          message: observed.message,
        };
      }
      snapshot = observed.value.snapshot;
      const page = observed.value.page;
      if (page === undefined || page === null) {
        return { ok: true, hasMore: false };
      }
      if (page.endOffsetBytes > readOffsets[stream]) {
        readOffsets[stream] = page.endOffsetBytes;
        if (stream === 'stdout') {
          args.onStdoutChunk(page.content);
        } else {
          stderr += page.content;
        }
      }
      return { ok: true, hasMore: page.hasMore };
    };

    for (;;) {
      // 두 스트림을 매 회차 함께 비운다 — protocol 모드는 예산이 차면 그 스트림의
      // 소스를 멈추므로, stderr를 안 읽으면 진단을 많이 쏟는 자식이 멈춰 서게 된다.
      const stdoutDrain = await drain('stdout');
      if (!stdoutDrain.ok) {
        return stdoutDrain;
      }
      const stderrDrain = await drain('stderr');
      if (!stderrDrain.ok) {
        return stderrDrain;
      }
      if (stdoutDrain.hasMore || stderrDrain.hasMore) {
        continue;
      }
      if (snapshot.status !== 'running') {
        terminalObserved = true;
        break;
      }
      // 남은 페이지가 없으면 시간이 아니라 사건을 기다린다 — 세션의 대기 상한(§4.6)이
      // 상한을 지키고, 출력이나 종료가 오면 즉시 깨므로 폴링이 아니다.
      const waited = await hostCommands.interact({
        stateRoot,
        threadId: SYSTEM_SESSION_OWNER,
        owner: 'system',
        outputRef,
        afterRevision: snapshot.revision,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!waited.ok) {
        return {
          ok: false,
          aborted: waited.reasonCode === 'wait_aborted',
          message: waited.message,
        };
      }
      snapshot = waited.value.snapshot;
    }

    return {
      ok: true,
      value: {
        status: snapshot.status,
        exitCode: snapshot.exitCode ?? null,
        stderr,
      },
    };
  } finally {
    if (!terminalObserved) {
      await terminateClaimedSession();
    }
  }
}

/**
 * 구분자 프레이밍. 페이지 경계는 프레임 경계와 무관하므로 완결된 프레임만 넘기고
 * 잔여는 다음 조각과 이어 붙인다. `flush`는 마지막 구분자 없는 잔여를 넘긴다 —
 * ripgrep의 마지막 줄이 그런 모양일 수 있다.
 */
export function createDelimitedFrameReader(
  delimiter: string,
  onFrame: (frame: string) => void,
): { consume: (chunk: string) => void; flush: () => void } {
  let pending = '';
  return {
    consume(chunk) {
      pending += chunk;
      const frames = pending.split(delimiter);
      pending = frames.pop() ?? '';
      for (const frame of frames) {
        onFrame(frame);
      }
    },
    flush() {
      if (pending !== '') {
        onFrame(pending);
        pending = '';
      }
    },
  };
}
