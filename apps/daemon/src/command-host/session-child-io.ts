import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { platform } from 'node:os';

import type { HostCommandOutputStream } from '../daemon/host-command-output-store.js';
import type { CommandSessionSubscriptionEvent } from './contract.js';
import type { SessionEntry, SessionTerminalState } from './session-core.js';

/**
 * P7.5 spec v4 §4 — 세션 **하나**의 자식 프로세스 입출력. 자식 배선, 출력
 * 적재와 역압, marker redaction, 구독자 알림, terminal 감지, 요청·강제 종료가
 * 여기 모여 있다.
 *
 * 이 경계의 조건은 하나다: 여기 있는 어떤 연산도 호스트의 세션 레지스트리를
 * 보거나 바꾸지 않는다. 모두 넘겨받은 `SessionEntry` 안에서만 움직인다.
 * 레지스트리를 건드려야 하는 지점은 `finalizeTerminal` 하나뿐이며 그것은
 * 소유자인 세션 코어가 주입한다.
 */

/** §7.5 — 알림 1건이 나르는 출력 조각의 상한. 초과분은 분할한다. */
const MAX_NOTIFICATION_CHUNK_BYTES = 64 * 1024;
// 요청 기반 종료 유예 — PTC 선례와 동일 값 (spec §4.5).
const REQUESTED_TERMINATION_GRACE_MS = 1_000;

interface SessionChildIoDeps {
  /** §4.1 스트림당 tail 링 예산 — 역압 판정의 기준선. */
  tailRingBytes: number;
  /**
   * claimed 세션이 terminal에 도달했을 때의 정착. 세션 레지스트리와 저널을
   * 소유한 세션 코어만 이것을 할 수 있으므로 주입받는다.
   */
  finalizeTerminal(entry: SessionEntry): Promise<void>;
}

interface SessionChildIo {
  attachChildProcess(entry: SessionEntry): void;
  applyStreamBackpressure(
    entry: SessionEntry,
    stream: HostCommandOutputStream,
  ): void;
  requestGracefulTermination(
    entry: SessionEntry,
    terminal: SessionTerminalState,
  ): void;
  forceTermination(entry: SessionEntry, terminal: SessionTerminalState): void;
}

export function createSessionChildIo(deps: SessionChildIoDeps): SessionChildIo {
  const { finalizeTerminal, tailRingBytes } = deps;

  return {
    applyStreamBackpressure,
    attachChildProcess,
    forceTermination,
    requestGracefulTermination,
  };

  function attachChildProcess(entry: SessionEntry): void {
    entry.child.stdout.on('data', (chunk: Buffer) => {
      appendOutput(entry, 'stdout', chunk);
    });
    entry.child.stderr.on('data', (chunk: Buffer) => {
      appendOutput(entry, 'stderr', chunk);
    });
    // 자식이 먼저 죽으면 파이프는 EPIPE/ECONNRESET으로 끝난다. 그것은 세션
    // 사건이 아니라 파이프가 제 수명을 다했다는 뜻이며, 종료 처리는 아래
    // 'close'가 이미 한다 — 핸들러가 없으면 프로세스가 죽는다.
    entry.child.stdin.on('error', () => {
      entry.stdinOpen = false;
    });
    entry.child.stdout.on('error', () => undefined);
    entry.child.stderr.on('error', () => undefined);
    entry.child.on('error', () => {
      handleChildTerminal(entry, {
        status: 'crash',
        exitCode: null,
        finishedAtMs: Date.now(),
        outputLimitExceeded: null,
      });
    });
    entry.child.on('exit', (exitCode, signal) => {
      // 'close'는 stdio가 모두 닫혀야 오므로, 명령이 자손을 백그라운드로
      // 띄우면 이미 끝난 프로세스가 계속 running으로 보고된다. 여기서
      // 프로세스 생존만 확정하고 출력은 계속 받는다 — 정착은 'close'가 한다.
      if (entry.processExit !== null) {
        return;
      }
      entry.processExit =
        signal === null
          ? {
              status: 'exit',
              exitCode: exitCode ?? 1,
              finishedAtMs: Date.now(),
            }
          : { status: 'signal', exitCode: null, finishedAtMs: Date.now() };
      // 관찰자가 이 사실을 바로 보게 한다. 깨우지 않으면 이미 끝난 명령을
      // yield 상한까지 계속 기다린다.
      bumpRevision(entry);
    });
    entry.child.on('close', (exitCode, signal) => {
      handleChildTerminal(
        entry,
        entry.terminalOverride ??
          (signal === null
            ? {
                status: 'exit',
                exitCode: exitCode ?? 1,
                finishedAtMs: Date.now(),
                outputLimitExceeded: null,
              }
            : {
                status: 'signal',
                exitCode: null,
                finishedAtMs: Date.now(),
                outputLimitExceeded: null,
              }),
      );
    });
  }

  /**
   * P7.6 §5.2 — 프로토콜 스트림은 버리지 않으므로, 예산을 넘으면 **읽는 쪽이
   * 따라올 때까지 소스를 멈춘다**. 자식의 stdout을 읽지 않으면 파이프가 차고
   * 자식이 write에서 막힌다 — 그것이 우리가 원하는 역압이다.
   */
  function applyStreamBackpressure(
    entry: SessionEntry,
    stream: HostCommandOutputStream,
  ): void {
    if (!isLosslessStream(entry, stream)) {
      return;
    }
    const source =
      stream === 'stdout' ? entry.child.stdout : entry.child.stderr;
    const side = stream === 'stdout' ? entry.stdout : entry.stderr;
    // 멈춘 stream은 'end'를 내지 않는다 — 종료를 향하는 세션을 멈춰 두면
    // 그 세션은 영원히 정착하지 못한다. 역압은 살아 있는 동안만 건다.
    const overBudget =
      entry.terminal === null &&
      entry.terminalOverride === null &&
      side.ring.retainedBytes >= tailRingBytes;
    if (overBudget && !source.isPaused()) {
      source.pause();
      return;
    }
    if (!overBudget && source.isPaused()) {
      source.resume();
    }
  }

  /** 역압으로 멈춰 둔 소스를 되살린다 — 종료·폐기 경로의 선행 조건이다. */
  function resumePausedOutput(entry: SessionEntry): void {
    for (const source of [entry.child.stdout, entry.child.stderr]) {
      if (source.isPaused()) {
        source.resume();
      }
    }
  }

  function appendOutput(
    entry: SessionEntry,
    stream: HostCommandOutputStream,
    chunk: Buffer,
  ): void {
    const side = stream === 'stdout' ? entry.stdout : entry.stderr;
    const redacted = side.redactor?.write(chunk) ?? chunk;
    if (redacted.length === 0) {
      return;
    }
    appendRedactedOutput(entry, stream, redacted);
  }

  function appendRedactedOutput(
    entry: SessionEntry,
    stream: HostCommandOutputStream,
    chunk: Buffer,
  ): void {
    // §7.5 maxNotificationChunkBytes — 알림 1건이 나르는 조각을 상한에서
    // 자른다. raw 바이트로 자르고 같은 StringDecoder에 순서대로 먹이므로
    // 경계에 걸친 코드포인트도 다음 조각에서 온전히 복원된다.
    for (
      let offset = 0;
      offset < chunk.length;
      offset += MAX_NOTIFICATION_CHUNK_BYTES
    ) {
      appendOutputSlice(
        entry,
        stream,
        chunk.subarray(offset, offset + MAX_NOTIFICATION_CHUNK_BYTES),
      );
    }
  }

  function appendOutputSlice(
    entry: SessionEntry,
    stream: HostCommandOutputStream,
    chunk: Buffer,
  ): void {
    if (entry.terminal !== null) {
      return;
    }
    const side = stream === 'stdout' ? entry.stdout : entry.stderr;
    if (
      entry.maxOutputBytesPerStream !== undefined &&
      side.ring.totalBytes + chunk.length > entry.maxOutputBytesPerStream
    ) {
      forceTermination(entry, {
        status: 'output_limit_exceeded',
        exitCode: null,
        finishedAtMs: Date.now(),
        outputLimitExceeded: {
          stream,
          maxOutputBytesPerStream: entry.maxOutputBytesPerStream,
        },
        terminationReason: 'caller_output_limit',
      });
      return;
    }
    const startOffset = side.ring.totalBytes;
    side.ring.append(chunk);
    applyStreamBackpressure(entry, stream);
    const endOffset = side.ring.totalBytes;
    const text = side.decoder.write(chunk);
    side.chars += text.length;
    entry.firstOutputAfterMs ??= Math.max(0, Date.now() - entry.startedAtMs);
    if (text.length > 0) {
      entry.onOutput?.({ stream, text });
    }
    // spec §7.3: 알림은 스트림별 raw byte 범위를 나른다. chunk(디코딩된
    // 문자열)는 best-effort 표시이며 정확 복구의 진실은 페이지 조회다.
    entry.revision += 1;
    if (text.length > 0) {
      notifySubscribers(entry, {
        kind: 'output',
        outputRef: entry.outputRef,
        revision: entry.revision,
        stream,
        startOffset,
        endOffset,
        chunk: text,
      });
    }
    wakeWaiters(entry);
  }

  function bumpRevision(entry: SessionEntry): void {
    entry.revision += 1;
    wakeWaiters(entry);
  }

  function wakeWaiters(entry: SessionEntry): void {
    const waiters = [...entry.outputWaiters];
    entry.outputWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  function notifySubscribers(
    entry: SessionEntry,
    event: CommandSessionSubscriptionEvent,
  ): void {
    for (const listener of entry.subscribers.values()) {
      listener(event);
    }
  }

  function handleChildTerminal(
    entry: SessionEntry,
    terminal: SessionTerminalState,
  ): void {
    if (entry.terminal !== null) {
      return;
    }
    resumePausedOutput(entry);
    if (entry.timeoutTimer !== undefined) {
      clearTimeout(entry.timeoutTimer);
    }
    if (
      entry.graceTimer !== undefined &&
      platform() !== 'win32' &&
      !isPosixProcessGroupAlive(entry.child)
    ) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = undefined;
    }
    detachSourceAbort(entry);
    flushRedactors(entry);
    flushDecoders(entry);
    entry.terminal = entry.terminalOverride ?? terminal;
    entry.stdinOpen = false;
    switch (entry.phase) {
      case 'unclaimed_running':
        entry.phase = 'unclaimed_terminal';
        break;
      case 'claiming_running':
        // terminal 이벤트는 유실되지 않고 승격된다 (§4.2).
        entry.phase = 'claiming_terminal';
        break;
      case 'claimed_running':
        entry.phase = 'finalizing';
        entry.finalizePromise = finalizeTerminal(entry);
        break;
      case 'discarding':
        break;
      default:
        break;
    }
    bumpRevision(entry);
    entry.resolveExit();
  }

  function flushRedactors(entry: SessionEntry): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const side = stream === 'stdout' ? entry.stdout : entry.stderr;
      const redactor = side.redactor;
      side.redactor = undefined;
      if (redactor === undefined) {
        continue;
      }
      const tail = redactor.end();
      if (tail.length > 0) {
        appendRedactedOutput(entry, stream, tail);
      }
    }
  }

  function flushDecoders(entry: SessionEntry): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const side = stream === 'stdout' ? entry.stdout : entry.stderr;
      const tail = side.decoder.end();
      if (tail.length > 0) {
        side.chars += tail.length;
        entry.onOutput?.({ stream, text: tail });
      }
    }
  }

  function requestGracefulTermination(
    entry: SessionEntry,
    terminal: SessionTerminalState,
  ): void {
    if (entry.terminal !== null || entry.terminalOverride !== null) {
      return;
    }
    // 종료를 향하는 세션은 더 멈춰 두지 않는다 (P7.6 §5.2 역압의 해제 지점).
    resumePausedOutput(entry);
    entry.terminalOverride = terminal;
    if (platform() === 'win32') {
      // Windows worker 모드는 비지원(spec §4.5) — inline은 현행 즉시
      // 트리 종료 의미론을 유지한다.
      terminateWindowsTree(entry.child);
      return;
    }
    signalProcessTree(entry.child, 'SIGTERM');
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined;
      // The process-group owner can outlive its leader. In particular, an MCP
      // launcher may exit on SIGTERM while a descendant with detached stdio
      // ignores it. Keep the group escalation alive after the direct child's
      // close event so that such descendants cannot escape the owned session.
      if (isPosixProcessGroupAlive(entry.child)) {
        signalProcessTree(entry.child, 'SIGKILL');
      }
    }, REQUESTED_TERMINATION_GRACE_MS);
    entry.graceTimer.unref?.();
  }

  function forceTermination(
    entry: SessionEntry,
    terminal: SessionTerminalState,
  ): void {
    if (entry.terminal !== null || entry.terminalOverride !== null) {
      return;
    }
    entry.terminalOverride = terminal;
    if (platform() === 'win32') {
      terminateWindowsTree(entry.child);
      return;
    }
    signalProcessTree(entry.child, 'SIGKILL');
  }
}

export function isLosslessStream(
  entry: SessionEntry,
  stream: HostCommandOutputStream,
): boolean {
  return (
    entry.streamMode === 'lossless' ||
    (entry.streamMode === 'protocol' && stream === 'stdout')
  );
}

export function detachSourceAbort(entry: {
  sourceSignal: AbortSignal | undefined;
  sourceAbortListener: (() => void) | undefined;
}): void {
  if (
    entry.sourceSignal !== undefined &&
    entry.sourceAbortListener !== undefined
  ) {
    entry.sourceSignal.removeEventListener('abort', entry.sourceAbortListener);
  }
  entry.sourceSignal = undefined;
  entry.sourceAbortListener = undefined;
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function isPosixProcessGroupAlive(
  child: ChildProcessWithoutNullStreams,
): boolean {
  const pid = child.pid;
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function terminateWindowsTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  const killer = spawn(
    process.env['ComSpec'] ?? 'cmd.exe',
    ['/d', '/s', '/c', `taskkill /pid ${pid} /t /f`],
    { stdio: 'ignore', windowsHide: true },
  );
  killer.once('error', () => {
    child.kill('SIGKILL');
  });
}
