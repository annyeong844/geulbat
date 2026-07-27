import { readFile } from 'node:fs/promises';

import {
  readHostCommandFullOutputArchivePage,
  readHostCommandOutputPage,
  readPersistedHostCommand,
  snapshotFromHostCommandMetadata,
  SYSTEM_SESSION_OWNER,
  writeHostCommandMetadata,
  type HostCommandMetadata,
  type HostCommandOutputPage,
  type HostCommandOutputStream,
} from '../daemon/host-command-output-store.js';
import { readPageFromWindow } from './durability.js';
import type {
  CommandHostOperation,
  HostCommandInteractionResult,
  HostCommandRuntime,
} from './contract.js';
import { isLosslessStream } from './session-child-io.js';
import type { SessionEntry, SessionTerminalState } from './session-core.js';
import { buildSnapshot, sessionPaths } from './session-snapshot.js';
import { waitForChange } from './session-wait.js';

/**
 * P7.5 spec v4 §4.7 — `interact` 한 번의 요청 본문. 부수효과 판정(순서),
 * stdin 쓰기, 종료 요청, 유계 대기, 페이지 조회, 스냅샷 구성이 여기 있다.
 *
 * 두 갈래가 있다: 세션이 아직 이 호스트에 남아 있으면 메모리 링에서 읽고,
 * 소유자가 사라졌으면 디스크 기록에서 읽는다. 어느 쪽도 세션 레지스트리를
 * 보지 않는다 — resident 갈래는 넘겨받은 `SessionEntry`만, persisted 갈래는
 * state root의 기록만 본다.
 */

/** §7.5 — 세션당 stdin 버퍼 상한. 초과는 `stdin_backpressure`. */
export const MAX_STDIN_BUFFERED_BYTES_PER_SESSION = 1024 * 1024;

export interface SessionInteractionDeps {
  /** §4.6 인라인 결과 예산 — 페이지 요청의 상한이다. */
  inlineMaxBytes: number;
  /** 미지정 yieldTimeMs를 호스트 상한으로 접는다 (§4.6). */
  resolveYieldTimeMs(requested: number | undefined): number;
  /** 스냅샷에 인라인 출력을 실을 수 있는지 — 호스트의 예산 판정이다. */
  inlineEligible(entry: SessionEntry): boolean;
  /** 페이지를 건넨 뒤 보관을 놓고 소스를 다시 흐르게 한다 (P7.6 §5.2). */
  applyStreamBackpressure(
    entry: SessionEntry,
    stream: HostCommandOutputStream,
  ): void;
  /** 명시적 terminate 요청의 종료 경로 (§4.5). */
  requestGracefulTermination(
    entry: SessionEntry,
    terminal: SessionTerminalState,
  ): void;
}

export interface SessionInteraction {
  interactWithResident(
    entry: SessionEntry,
    args: Parameters<HostCommandRuntime['interact']>[0],
  ): Promise<HostCommandInteractionResult>;
  interactWithPersisted(
    args: Parameters<HostCommandRuntime['interact']>[0],
  ): Promise<HostCommandInteractionResult>;
}

export function createSessionInteraction(
  deps: SessionInteractionDeps,
): SessionInteraction {
  const {
    applyStreamBackpressure,
    inlineEligible,
    inlineMaxBytes,
    requestGracefulTermination,
    resolveYieldTimeMs,
  } = deps;

  return {
    interactWithPersisted,
    interactWithResident,
  };

  /**
   * §4.7 — 이 요청의 부수효과를 지금 적용해야 하는지 판정한다.
   *
   * 순서가 판정한다: 같은 파사드의 같은 seq는 이미 적용된 요청의 재전송이고,
   * 더 작은 seq는 그 사이에 다른 연산이 끼어든 뒤 도착한 재전송이다. 후자는
   * 지금 적용하면 호출자가 의도한 순서를 뒤집으므로 되돌린다.
   *
   * `clientId`가 다르면 독립 연산이다. 일반 호출자는 facade마다 새 ID를 쓰고,
   * durable invocation은 daemon이 바뀌어도 체크포인트의 같은 pair를 다시
   * 보내므로 이미 적용된 효과만 중복으로 걸러진다.
   */
  function judgeOperation(
    entry: SessionEntry,
    operation: CommandHostOperation | undefined,
  ):
    | { apply: true }
    | { apply: false; duplicate: true }
    | {
        apply: false;
        duplicate: false;
        reasonCode: 'operation_superseded';
        message: string;
      } {
    const last = entry.lastOperation;
    if (
      operation === undefined ||
      last === null ||
      last.clientId !== operation.clientId ||
      operation.seq > last.seq
    ) {
      return { apply: true };
    }
    if (operation.seq === last.seq) {
      return { apply: false, duplicate: true };
    }
    return {
      apply: false,
      duplicate: false,
      reasonCode: 'operation_superseded',
      message: `host command session already applied a later operation (${last.seq}); operation ${operation.seq} cannot be applied out of order.`,
    };
  }

  async function interactWithResident(
    entry: SessionEntry,
    args: Parameters<HostCommandRuntime['interact']>[0],
  ): Promise<HostCommandInteractionResult> {
    const baselineRevision = args.afterRevision ?? entry.revision;
    const hasSideEffect =
      args.chars !== undefined ||
      args.closeStdin === true ||
      args.terminate === true;
    const judged = hasSideEffect
      ? judgeOperation(entry, args.operation)
      : ({ apply: true } as const);
    if (!judged.apply && !judged.duplicate) {
      return {
        ok: false,
        reasonCode: judged.reasonCode,
        message: judged.message,
      };
    }
    // 중복이면 관찰만 남는다 — 부수효과는 건너뛰고 대기·페이지·스냅샷은
    // 그대로 수행해 호출자가 재시도로 최신 상태를 받게 한다.
    const applySideEffects = judged.apply;
    // 효과가 실제로 일어난 뒤에만 기록한다. 실패한 요청(backpressure 등)까지
    // 적용으로 세면 재시도가 중복으로 걸러져 쓰기가 조용히 사라진다. 아래
    // 부수효과들은 await 없이 이어지므로 그 사이에 재전송이 끼어들 틈은 없다.
    const markApplied = (): void => {
      if (args.operation !== undefined) {
        entry.lastOperation = args.operation;
      }
    };
    if (applySideEffects && args.chars !== undefined) {
      if (!entry.stdinOpen || entry.terminal !== null) {
        return {
          ok: false,
          reasonCode: 'not_running',
          message: 'host command stdin is not open.',
        };
      }
      const written = writeStdin(entry, args.chars);
      if (!written.ok) {
        return written;
      }
      markApplied();
    }
    if (applySideEffects && args.closeStdin === true) {
      if (!entry.stdinOpen || entry.terminal !== null) {
        return {
          ok: false,
          reasonCode: 'not_running',
          message: 'host command stdin is not open.',
        };
      }
      entry.stdinOpen = false;
      entry.child.stdin.end();
      markApplied();
    }
    if (applySideEffects && args.terminate === true) {
      requestGracefulTermination(entry, {
        status: 'signal',
        exitCode: null,
        finishedAtMs: Date.now(),
        outputLimitExceeded: null,
        terminationReason: 'explicit_terminate',
      });
      markApplied();
    }

    const waitResult = await waitForChange(entry, {
      afterRevision: baselineRevision,
      yieldTimeMs: resolveYieldTimeMs(args.yieldTimeMs),
      signal: args.signal,
    });
    if (!waitResult.ok) {
      return waitResult;
    }
    // terminal 스냅샷은 내구화 완료 후에만 관찰된다 — 메모리상 종료와
    // 디스크 상태가 갈라진 창을 관찰자에게 노출하지 않는다 (spec §6.3의
    // pending-I/O 원칙).
    if (entry.finalizePromise !== undefined) {
      await entry.finalizePromise;
    }
    let page: HostCommandOutputPage | null = null;
    if (args.page !== undefined) {
      if (args.page.limitBytes > inlineMaxBytes) {
        return {
          ok: false,
          reasonCode: 'invalid_args',
          message: `limitBytes exceeds the configured inline result budget of ${inlineMaxBytes} bytes.`,
        };
      }
      if (
        (args.page.deferRelease === true ||
          args.page.releaseUpToBytes !== undefined) &&
        !isLosslessStream(entry, args.page.stream)
      ) {
        return {
          ok: false,
          reasonCode: 'invalid_args',
          message:
            'deferred output release is only valid for a lossless stream.',
        };
      }
      if (
        args.page.releaseUpToBytes !== undefined &&
        args.page.deferRelease !== true
      ) {
        return {
          ok: false,
          reasonCode: 'invalid_args',
          message: 'releaseUpToBytes requires deferRelease.',
        };
      }
      const side = args.page.stream === 'stdout' ? entry.stdout : entry.stderr;
      if (args.page.releaseUpToBytes !== undefined) {
        if (
          args.page.releaseUpToBytes < side.ring.omittedBytes ||
          args.page.releaseUpToBytes > args.page.offsetBytes ||
          args.page.releaseUpToBytes > side.ring.totalBytes
        ) {
          return {
            ok: false,
            reasonCode: 'invalid_args',
            message:
              'releaseUpToBytes must be within the retained output window and no greater than offsetBytes.',
          };
        }
        side.ring.releaseUpTo(args.page.releaseUpToBytes);
        applyStreamBackpressure(entry, args.page.stream);
      }
      if (args.page.offsetBytes < side.ring.omittedBytes) {
        const archivedPage = await readHostCommandFullOutputArchivePage({
          paths: sessionPaths(entry),
          stream: args.page.stream,
          offsetBytes: args.page.offsetBytes,
          limitBytes: args.page.limitBytes,
          archivedBytes: side.ring.omittedBytes,
          totalBytes: side.ring.totalBytes,
          inlineMaxBytes,
        });
        if (!archivedPage.ok && archivedPage.reasonCode !== 'not_found') {
          return archivedPage;
        }
        page = archivedPage.ok
          ? archivedPage.value
          : readPageFromWindow({
              window: {
                baseOffset: side.ring.omittedBytes,
                totalBytes: side.ring.totalBytes,
                buffer: side.ring.snapshot(),
              },
              stream: args.page.stream,
              offsetBytes: args.page.offsetBytes,
              limitBytes: args.page.limitBytes,
            });
      } else {
        page = readPageFromWindow({
          window: {
            baseOffset: side.ring.omittedBytes,
            totalBytes: side.ring.totalBytes,
            buffer: side.ring.snapshot(),
          },
          stream: args.page.stream,
          offsetBytes: args.page.offsetBytes,
          limitBytes: args.page.limitBytes,
        });
      }
      if (
        isLosslessStream(entry, args.page.stream) &&
        args.page.deferRelease !== true &&
        page !== null
      ) {
        // 건네준 만큼만 놓는다 — 그래야 아직 안 읽은 바이트는 보관되고,
        // 읽은 만큼 자리가 나 소스가 다시 흐른다 (P7.6 §5.2). 마지막 페이지는
        // `nextOffsetBytes`가 null이므로 실제로 건넨 끝(`endOffsetBytes`)을
        // 쓴다 — 그래야 다 읽은 뒤에도 보관이 남지 않는다.
        side.ring.releaseUpTo(page.endOffsetBytes);
        applyStreamBackpressure(entry, args.page.stream);
      }
    }
    return {
      ok: true,
      value: {
        snapshot: buildSnapshot(entry, inlineEligible, {
          includeInline: false,
          outputRef: entry.outputRef,
        }),
        page,
      },
    };
  }

  async function interactWithPersisted(
    args: Parameters<HostCommandRuntime['interact']>[0],
  ): Promise<HostCommandInteractionResult> {
    const persisted = await readPersistedHostCommand({
      stateRoot: args.stateRoot,
      threadId:
        (args.owner ?? 'thread') === 'system'
          ? SYSTEM_SESSION_OWNER
          : args.threadId,
      outputRef: args.outputRef,
    });
    if (!persisted.ok) {
      return persisted;
    }
    let record = persisted.value;
    if (record.metadata.status === 'running') {
      // 세션 소유자(command host)가 사라진 채 남은 기록 — 워커/데몬
      // 사망으로 링 내용은 유실됐다 (spec §8.2).
      const metadata: HostCommandMetadata = {
        ...record.metadata,
        status: 'command_host_interrupted',
        terminationReason: 'command_host_lost',
        exitCode: null,
        finishedAtMs: Date.now(),
        stdinOpen: false,
        revision: record.metadata.revision + 1,
      };
      try {
        await writeHostCommandMetadata({ paths: record.paths, metadata });
      } catch (error: unknown) {
        return {
          ok: false,
          reasonCode: 'output_store_failed',
          message: getErrorMessage(error),
        };
      }
      record = { ...record, metadata };
    }
    let page: HostCommandOutputPage | null = null;
    if (args.page !== undefined) {
      if (args.page.limitBytes > inlineMaxBytes) {
        return {
          ok: false,
          reasonCode: 'invalid_args',
          message: `limitBytes exceeds the configured inline result budget of ${inlineMaxBytes} bytes.`,
        };
      }
      if (
        args.page.releaseUpToBytes !== undefined &&
        (args.page.deferRelease !== true ||
          args.page.releaseUpToBytes > args.page.offsetBytes)
      ) {
        return {
          ok: false,
          reasonCode: 'invalid_args',
          message:
            'releaseUpToBytes requires deferRelease and cannot exceed offsetBytes.',
        };
      }
      const baseOffset =
        args.page.stream === 'stdout'
          ? record.metadata.stdoutBaseOffset
          : record.metadata.stderrBaseOffset;
      if (record.metadata.fullOutputAvailable === true) {
        const fullPage = await readHostCommandOutputPage({
          paths: record.paths,
          page: args.page,
          inlineMaxBytes,
          fullOutputAvailable: true,
        });
        if (!fullPage.ok) {
          return fullPage;
        }
        page = fullPage.value;
      } else if (baseOffset !== undefined) {
        const path =
          args.page.stream === 'stdout'
            ? record.paths.stdout
            : record.paths.stderr;
        let buffer: Buffer;
        try {
          buffer = await readFile(path);
        } catch {
          buffer = Buffer.alloc(0);
        }
        page = readPageFromWindow({
          window: {
            baseOffset,
            totalBytes: baseOffset + buffer.length,
            buffer,
          },
          stream: args.page.stream,
          offsetBytes: args.page.offsetBytes,
          limitBytes: args.page.limitBytes,
        });
      } else {
        const legacyPage = await readHostCommandOutputPage({
          paths: record.paths,
          page: args.page,
          inlineMaxBytes,
        });
        if (!legacyPage.ok) {
          return legacyPage;
        }
        page = legacyPage.value;
      }
    }
    return {
      ok: true,
      value: {
        snapshot: snapshotFromHostCommandMetadata(record.metadata),
        page,
      },
    };
  }

  function writeStdin(
    entry: SessionEntry,
    chars: string,
  ):
    | { ok: true }
    | {
        ok: false;
        reasonCode: 'not_running' | 'stdin_backpressure';
        message: string;
      } {
    // §7.5 — 자식이 읽지 않는 동안 stdin 버퍼가 무한히 자라지 않게 한다.
    // 상한을 넘으면 버퍼를 늘리는 대신 호출자에게 되돌린다.
    const buffered = entry.child.stdin.writableLength;
    if (
      buffered + Buffer.byteLength(chars) >
      MAX_STDIN_BUFFERED_BYTES_PER_SESSION
    ) {
      return {
        ok: false,
        reasonCode: 'stdin_backpressure',
        message: `host command stdin buffer is full (${buffered} bytes pending); the process is not reading.`,
      };
    }
    try {
      // flush 완료를 기다리지 않는다. 자식이 stdin을 읽지 않으면 그 콜백은
      // 영원히 오지 않으므로, 기다리면 이 RPC가 세션 수명 내내 매달린다.
      // 유계성은 위의 버퍼 상한이 지키고, 파이프 파손은 stdinOpen을 내려
      // 다음 호출에서 not_running으로 드러난다 (§4.7 exactly-once 비보장).
      entry.child.stdin.write(chars, (error) => {
        if (error) {
          entry.stdinOpen = false;
        }
      });
    } catch (error: unknown) {
      entry.stdinOpen = false;
      return {
        ok: false,
        reasonCode: 'not_running',
        message: getErrorMessage(error),
      };
    }
    return { ok: true };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'host command failed';
}
