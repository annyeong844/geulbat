import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  HostCommandMetadata,
  HostCommandOutputPage,
  HostCommandOutputStream,
  HostCommandPaths,
} from '../daemon/host-command-output-store.js';

// P7.5 spec v4 §5.3: 내구화 커밋은 temp 작성 → fsync → atomic rename →
// 부모 디렉터리 fsync 순서를 지킨다. claim 커밋점은 이 시퀀스의 마지막
// fsync 성공 시점이다.

const UTF8_MAX_CODE_POINT_BYTES = 4;

/**
 * 내구화 시퀀스의 관찰 지점. §14 T3·T9·T19는 "각 fsync 지점에 실패·취소·
 * 종료·단절을 끼워도 §4.2 표의 허용 상태 하나로 수렴하는가"를 묻는데, 그
 * 상태들은 밖에서 만들 수 없다 — 시퀀스 **안쪽의 시각**이기 때문이다.
 *
 * 그래서 저장소를 대역으로 바꾸는 대신 단계 사이의 **틈만 연다**: 실제
 * open·write·fsync·rename은 그대로 일어나고, 관찰자는 그 사이에서 제어를
 * 넘겨받을 뿐이다. 관찰자가 throw하면 그 지점에서 시퀀스가 실패한다.
 */
export type DurabilityStage =
  | 'claim.begin'
  | 'claim.temp_written'
  | 'claim.temp_synced'
  | 'claim.renamed'
  | 'claim.committed'
  | 'terminal.artifacts_begin'
  | 'terminal.artifacts_persisted'
  | 'terminal.metadata_begin'
  | 'terminal.metadata_persisted';

export type DurabilityStageObserver = (
  stage: DurabilityStage,
) => Promise<void> | void;

interface DurableWriteStages {
  afterWrite?: () => Promise<void> | void;
  afterSync?: () => Promise<void> | void;
  afterRename?: () => Promise<void> | void;
  afterCommit?: () => Promise<void> | void;
}

export async function writeDurableFile(
  path: string,
  data: string | Buffer,
  stages?: DurableWriteStages,
): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(data);
    await stages?.afterWrite?.();
    await handle.sync();
    await stages?.afterSync?.();
  } finally {
    await closeQuietly(handle);
  }
  try {
    await rename(tempPath, path);
  } catch (error: unknown) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await stages?.afterRename?.();
  await syncDirectory(dirname(path));
  await stages?.afterCommit?.();
}

export async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // 일부 플랫폼은 디렉터리 fsync를 지원하지 않는다(Windows 등).
    // rename까지 완료된 상태이므로 best-effort로 둔다.
  } finally {
    await closeQuietly(handle);
  }
}

/** claim 커밋 — 성공 반환 시점이 spec §4.2.1의 claim 커밋점이다. */
export async function commitClaimMetadata(args: {
  paths: HostCommandPaths;
  metadata: HostCommandMetadata;
  observe?: DurabilityStageObserver;
}): Promise<void> {
  const observe = args.observe;
  await observe?.('claim.begin');
  await mkdir(args.paths.directory, { recursive: true });
  await syncDirectory(dirname(args.paths.directory));
  await writeDurableFile(
    args.paths.metadata,
    `${JSON.stringify(args.metadata, null, 2)}\n`,
    observe === undefined
      ? undefined
      : {
          afterWrite: () => observe('claim.temp_written'),
          afterSync: () => observe('claim.temp_synced'),
          afterRename: () => observe('claim.renamed'),
          afterCommit: () => observe('claim.committed'),
        },
  );
}

interface TerminalPersistOutcome {
  artifactOk: boolean;
  metadataOk: boolean;
}

/** terminal 내구화 — artifact 먼저, metadata 나중 (spec §5.3 사분법). */
export async function persistTerminalArtifacts(args: {
  paths: HostCommandPaths;
  stdoutTail: Buffer;
  stderrTail: Buffer;
  metadata: HostCommandMetadata;
  observe?: DurabilityStageObserver;
}): Promise<TerminalPersistOutcome> {
  const observe = args.observe;
  let artifactOk = true;
  try {
    await observe?.('terminal.artifacts_begin');
    await mkdir(args.paths.directory, { recursive: true });
    await writeDurableFile(args.paths.stdout, args.stdoutTail);
    await writeDurableFile(args.paths.stderr, args.stderrTail);
    await observe?.('terminal.artifacts_persisted');
  } catch {
    artifactOk = false;
  }
  let metadataOk = true;
  try {
    await observe?.('terminal.metadata_begin');
    const metadata: HostCommandMetadata = artifactOk
      ? args.metadata
      : { ...args.metadata, outputPersistFailed: true };
    await writeDurableFile(
      args.paths.metadata,
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await observe?.('terminal.metadata_persisted');
  } catch {
    metadataOk = false;
  }
  return { artifactOk, metadataOk };
}

interface OutputPageWindow {
  /** 이 버퍼의 첫 바이트가 갖는 절대 오프셋 (= omitted/baseOffset). */
  baseOffset: number;
  /** 절대 총량 (= baseOffset + buffer.length). */
  totalBytes: number;
  buffer: Buffer;
}

/**
 * spec v4 §4.3 좌표계의 단일 페이지 구현 — live 링과 terminal artifact가
 * 같은 함수를 쓰므로 같은 오프셋은 같은 문자열을 반환한다(T7).
 * 창 밖(이전) 오프셋은 baseOffset으로 클램프하고, UTF-8 continuation
 * 바이트에서 시작하면 경계까지 전진해 contentStartOffset으로 보고한다.
 */
export function readPageFromWindow(args: {
  window: OutputPageWindow;
  stream: HostCommandOutputStream;
  offsetBytes: number;
  limitBytes: number;
}): HostCommandOutputPage {
  const { window, stream, limitBytes } = args;
  const clamped = Math.min(
    Math.max(args.offsetBytes, window.baseOffset),
    window.totalBytes,
  );
  let contentStart = clamped;
  while (
    contentStart < window.totalBytes &&
    contentStart - clamped < UTF8_MAX_CODE_POINT_BYTES &&
    isUtf8Continuation(window.buffer[contentStart - window.baseOffset])
  ) {
    contentStart += 1;
  }
  const sliceStart = contentStart - window.baseOffset;
  const requested = Math.min(limitBytes, window.buffer.length - sliceStart);
  const raw = window.buffer.subarray(sliceStart, sliceStart + requested);
  const validBytes = findValidUtf8PrefixLength(raw);
  const endOffsetBytes = contentStart + validBytes;
  const hasMore = endOffsetBytes < window.totalBytes;
  return {
    stream,
    offsetBytes: clamped,
    endOffsetBytes,
    totalBytes: window.totalBytes,
    limitBytes,
    hasMore,
    nextOffsetBytes: hasMore ? endOffsetBytes : null,
    content: raw.subarray(0, validBytes).toString('utf8'),
    contentStartOffset: contentStart,
    earliestAvailableOffset: window.baseOffset,
  };
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function findValidUtf8PrefixLength(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - (UTF8_MAX_CODE_POINT_BYTES - 1));
  for (let end = buffer.length; end >= minimum; end -= 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
      return end;
    } catch {
      continue;
    }
  }
  return 0;
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // 원 실패를 close 실패로 대체하지 않는다.
  }
}
