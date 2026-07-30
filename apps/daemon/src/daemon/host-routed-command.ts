import type {
  CommandSessionStreamMode,
  HostCommandRuntime,
} from '../command-host/contract.js';
import {
  SYSTEM_SESSION_OWNER,
  type HostCommandOutputStream,
  type HostCommandSnapshot,
} from './host-command-output-store.js';

// P7.6 item 4 (직접 자식 정리) — 데몬이 직접 낳던 배치 명령을 command-host 워커의
// system 세션에서 돌리는 공통 경로다. 소비자마다 결과 계약이 다르므로(docker는
// DockerClientCommandResult, 브라우즈 발견은 {error,status,stdout}) 이 파일은
// "어떻게 돌려서 무엇을 관찰했는가"까지만 소유하고 계약 매핑은 각 어댑터가 한다.
//
// runSystemCommand(git/marketplace seam)와 기다리는 방식이 다르다: 그것은
// waitForInitialResult 한 번으로 끝내 §4.6 상한(기본 30초)을 넘긴 명령을
// 'running'으로 돌려줄 수 있다. P7.5의 교훈("고정 시간 창 가정 금지")대로 여기서는
// 시간이 아니라 사건을 기다려 terminal이 될 때까지 관찰을 이어붙인다.

interface HostRoutedCommandInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 명령의 stdin으로 한 번만 전달할 exact bytes. */
  initialStdin?: Uint8Array;
  timeoutMs?: number;
  streamMode?: CommandSessionStreamMode;
  /** 세션에 거는 스트림별 출력 상한. */
  maxOutputBytesPerStream?: number;
  signal?: AbortSignal;
}

type HostRoutedCommandObservation =
  | { ok: true; snapshot: HostCommandSnapshot; stdout: string; stderr: string }
  | { ok: false; aborted: boolean; message: string };

export type HostRoutedCommandBytesObservation =
  | { ok: true; snapshot: HostCommandSnapshot; stdout: Buffer; stderr: Buffer }
  | { ok: false; aborted: boolean; message: string };

export async function runHostRoutedSystemCommand(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  /**
   * 회수해 올 출력의 총 상한. 출력을 진단으로만 쓰는 소비자가 정한다. 생략하면
   * 스트림 끝까지 읽는다 — 출력 자체가 결과인 소비자(PTC)는 잘린 성공을 받으면
   * 안 되기 때문이다. 세션에 건 상한(maxOutputBytesPerStream)을 넘긴 출력은 잘림이
   * 아니라 output_limit_exceeded로 드러난다.
   */
  maxOutputBytes?: number;
  /**
   * 한 번의 페이지 요청 상한. 세션 inline 예산 이하여야 페이지 읽기가 거부되지
   * 않는다(§4.2 — interact page limitBytes는 inlineMaxBytes 이하여야 한다).
   * 상한이 총량보다 작으면 nextOffsetBytes를 따라 이어 읽는다.
   */
  pageLimitBytes: number;
  invocation: HostRoutedCommandInvocation;
}): Promise<HostRoutedCommandObservation> {
  const {
    hostCommands,
    stateRoot,
    maxOutputBytes,
    pageLimitBytes,
    invocation,
  } = args;
  const started = await startHostRoutedSystemCommand({
    hostCommands,
    stateRoot,
    invocation,
  });
  if (!started.ok) {
    return started;
  }
  if (invocation.streamMode === 'lossless') {
    return await readLosslessCommandToTerminal({
      hostCommands,
      stateRoot,
      outputRef: started.outputRef,
      pageLimitBytes,
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
    });
  }

  const terminal = await waitForTerminalSnapshot({
    hostCommands,
    stateRoot,
    outputRef: started.outputRef,
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  });
  if (!terminal.ok) {
    // 대기 취소는 취소로, 그 밖의 실패(세션 소실·저장소 오류)는 실행 불가로
    // 되돌린다 — 어느 쪽인지는 소비자의 계약이 구분한다.
    return {
      ok: false,
      aborted: terminal.reasonCode === 'wait_aborted',
      message: terminal.message,
    };
  }

  const snapshot = terminal.snapshot;
  const readOptions = {
    hostCommands,
    stateRoot,
    outputRef: started.outputRef,
    pageLimitBytes,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  };
  // inline 응답에는 출력이 실려 오고, 그보다 큰 출력은 세션 저장소에 남아 페이지로만
  // 읽힌다 — 성공한 출력을 한 페이지로 잘라 부분 진실로 돌려주지 않기 위해 상한까지
  // 이어 읽는다.
  const stdout =
    snapshot.stdout === null
      ? await readStream({ ...readOptions, stream: 'stdout' })
      : ({ ok: true, content: snapshot.stdout } as const);
  if (!stdout.ok) {
    return {
      ok: false,
      aborted: stdout.reasonCode === 'wait_aborted',
      message: stdout.message,
    };
  }
  const stderr =
    snapshot.stderr === null
      ? await readStream({ ...readOptions, stream: 'stderr' })
      : ({ ok: true, content: snapshot.stderr } as const);
  if (!stderr.ok) {
    return {
      ok: false,
      aborted: stderr.reasonCode === 'wait_aborted',
      message: stderr.message,
    };
  }
  return {
    ok: true,
    snapshot,
    stdout: stdout.content,
    stderr: stderr.content,
  };
}

export async function runHostRoutedSystemCommandBytes(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  invocation: Omit<
    HostRoutedCommandInvocation,
    'maxOutputBytesPerStream' | 'streamMode'
  > & {
    maxOutputBytesPerStream: number;
  };
}): Promise<HostRoutedCommandBytesObservation> {
  if (args.pageLimitBytes < 4) {
    return {
      ok: false,
      aborted: false,
      message: 'raw command output page budget must be at least 4 bytes',
    };
  }
  const invocation: HostRoutedCommandInvocation = {
    ...args.invocation,
    streamMode: 'lossless',
  };
  const started = await startHostRoutedSystemCommand({
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    invocation,
  });
  if (!started.ok) {
    return started;
  }
  return await readLosslessBytesCommandToTerminal({
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    outputRef: started.outputRef,
    pageLimitBytes: Math.floor(args.pageLimitBytes / 4) * 3,
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  });
}

async function startHostRoutedSystemCommand(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  invocation: HostRoutedCommandInvocation;
}): Promise<
  | { ok: true; outputRef: string }
  | { ok: false; aborted: boolean; message: string }
> {
  const { hostCommands, stateRoot, invocation } = args;
  // 직접 러너와 같은 사전 취소 처리 — 시작하지 않고 취소로 되돌린다.
  if (invocation.signal?.aborted === true) {
    return {
      ok: false,
      aborted: true,
      message: 'command aborted before start',
    };
  }
  const started = await hostCommands.start({
    executable: invocation.executable,
    args: [...invocation.args],
    cwd: invocation.cwd,
    env: invocation.env,
    stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    runId: 'system',
    callId: 'system',
    stdinMode: 'closed',
    ...(invocation.initialStdin === undefined
      ? {}
      : { initialStdin: invocation.initialStdin }),
    ...(invocation.timeoutMs === undefined
      ? {}
      : { timeoutMs: invocation.timeoutMs }),
    ...(invocation.streamMode === undefined
      ? {}
      : { streamMode: invocation.streamMode }),
    ...(invocation.maxOutputBytesPerStream === undefined
      ? {}
      : { maxOutputBytesPerStream: invocation.maxOutputBytesPerStream }),
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  });
  return started.ok
    ? { ok: true, outputRef: started.outputRef }
    : { ok: false, aborted: false, message: started.message };
}

async function readLosslessCommandToTerminal(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  outputRef: string;
  pageLimitBytes: number;
  signal?: AbortSignal;
}): Promise<HostRoutedCommandObservation> {
  const initial = await args.hostCommands.waitForInitialResult({
    stateRoot: args.stateRoot,
    outputRef: args.outputRef,
    yieldTimeMs: 0,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!initial.ok) {
    return {
      ok: false,
      aborted: initial.reasonCode === 'wait_aborted',
      message: initial.message,
    };
  }
  if (initial.value.outputRef === null) {
    return {
      ok: true,
      snapshot: initial.value,
      stdout: initial.value.stdout ?? '',
      stderr: initial.value.stderr ?? '',
    };
  }

  const offsets: Record<HostCommandOutputStream, number> = {
    stdout: 0,
    stderr: 0,
  };
  const output: Record<HostCommandOutputStream, string> = {
    stdout: '',
    stderr: '',
  };
  let snapshot = initial.value;
  for (;;) {
    const stdout = await readLosslessStreamPage({
      ...args,
      stream: 'stdout',
      offsetBytes: offsets.stdout,
    });
    if (!stdout.ok) {
      return stdout;
    }
    offsets.stdout = stdout.nextOffsetBytes;
    output.stdout += stdout.content;
    snapshot = stdout.snapshot;

    const stderr = await readLosslessStreamPage({
      ...args,
      stream: 'stderr',
      offsetBytes: offsets.stderr,
    });
    if (!stderr.ok) {
      return stderr;
    }
    offsets.stderr = stderr.nextOffsetBytes;
    output.stderr += stderr.content;
    snapshot = stderr.snapshot;

    if (
      stdout.hasMore ||
      stderr.hasMore ||
      offsets.stdout < snapshot.stdoutBytes ||
      offsets.stderr < snapshot.stderrBytes
    ) {
      continue;
    }
    if (snapshot.status !== 'running') {
      return {
        ok: true,
        snapshot,
        stdout: output.stdout,
        stderr: output.stderr,
      };
    }
    const changed = await args.hostCommands.interact({
      stateRoot: args.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: args.outputRef,
      afterRevision: snapshot.revision,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!changed.ok) {
      return {
        ok: false,
        aborted: changed.reasonCode === 'wait_aborted',
        message: changed.message,
      };
    }
    snapshot = changed.value.snapshot;
  }
}

async function readLosslessBytesCommandToTerminal(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  outputRef: string;
  pageLimitBytes: number;
  signal?: AbortSignal;
}): Promise<HostRoutedCommandBytesObservation> {
  const initial = await args.hostCommands.waitForInitialResult({
    stateRoot: args.stateRoot,
    outputRef: args.outputRef,
    yieldTimeMs: 0,
    requiresOutputRef: true,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!initial.ok) {
    return {
      ok: false,
      aborted: initial.reasonCode === 'wait_aborted',
      message: initial.message,
    };
  }
  if (initial.value.outputRef === null) {
    if (initial.value.stdoutBytes === 0 && initial.value.stderrBytes === 0) {
      return {
        ok: true,
        snapshot: initial.value,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    return {
      ok: false,
      aborted: false,
      message: 'raw command output was returned only as a text projection',
    };
  }

  const offsets: Record<HostCommandOutputStream, number> = {
    stdout: 0,
    stderr: 0,
  };
  const output: Record<HostCommandOutputStream, Buffer[]> = {
    stdout: [],
    stderr: [],
  };
  let snapshot = initial.value;
  for (;;) {
    const stdout = await readLosslessBytesStreamPage({
      ...args,
      stream: 'stdout',
      offsetBytes: offsets.stdout,
    });
    if (!stdout.ok) {
      return stdout;
    }
    offsets.stdout = stdout.nextOffsetBytes;
    output.stdout.push(stdout.content);
    snapshot = stdout.snapshot;

    const stderr = await readLosslessBytesStreamPage({
      ...args,
      stream: 'stderr',
      offsetBytes: offsets.stderr,
    });
    if (!stderr.ok) {
      return stderr;
    }
    offsets.stderr = stderr.nextOffsetBytes;
    output.stderr.push(stderr.content);
    snapshot = stderr.snapshot;

    if (
      stdout.hasMore ||
      stderr.hasMore ||
      offsets.stdout < snapshot.stdoutBytes ||
      offsets.stderr < snapshot.stderrBytes
    ) {
      continue;
    }
    if (snapshot.status !== 'running') {
      return {
        ok: true,
        snapshot,
        stdout: Buffer.concat(output.stdout, offsets.stdout),
        stderr: Buffer.concat(output.stderr, offsets.stderr),
      };
    }
    const changed = await args.hostCommands.interact({
      stateRoot: args.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: args.outputRef,
      afterRevision: snapshot.revision,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!changed.ok) {
      return {
        ok: false,
        aborted: changed.reasonCode === 'wait_aborted',
        message: changed.message,
      };
    }
    snapshot = changed.value.snapshot;
  }
}

async function readLosslessStreamPage(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  outputRef: string;
  stream: HostCommandOutputStream;
  offsetBytes: number;
  pageLimitBytes: number;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      content: string;
      nextOffsetBytes: number;
      hasMore: boolean;
      snapshot: HostCommandSnapshot;
    }
  | { ok: false; aborted: boolean; message: string }
> {
  const observed = await args.hostCommands.interact({
    stateRoot: args.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    outputRef: args.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: args.stream,
      offsetBytes: args.offsetBytes,
      limitBytes: args.pageLimitBytes,
    },
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!observed.ok) {
    return {
      ok: false,
      aborted: observed.reasonCode === 'wait_aborted',
      message: observed.message,
    };
  }
  const page = observed.value.page;
  if (page === undefined) {
    return {
      ok: false,
      aborted: false,
      message: `host command ${args.stream} output page was missing.`,
    };
  }
  if (page === null) {
    return {
      ok: true,
      content: '',
      nextOffsetBytes: args.offsetBytes,
      hasMore: false,
      snapshot: observed.value.snapshot,
    };
  }
  if (
    page.offsetBytes !== args.offsetBytes ||
    page.endOffsetBytes < args.offsetBytes ||
    (page.hasMore && page.endOffsetBytes === args.offsetBytes)
  ) {
    return {
      ok: false,
      aborted: false,
      message: `host command ${args.stream} output page did not advance from ${String(
        args.offsetBytes,
      )}.`,
    };
  }
  return {
    ok: true,
    content: page.content,
    nextOffsetBytes: page.endOffsetBytes,
    hasMore: page.hasMore,
    snapshot: observed.value.snapshot,
  };
}

async function readLosslessBytesStreamPage(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  outputRef: string;
  stream: HostCommandOutputStream;
  offsetBytes: number;
  pageLimitBytes: number;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      content: Buffer;
      nextOffsetBytes: number;
      hasMore: boolean;
      snapshot: HostCommandSnapshot;
    }
  | { ok: false; aborted: boolean; message: string }
> {
  const observed = await args.hostCommands.interact({
    stateRoot: args.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    outputRef: args.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: args.stream,
      offsetBytes: args.offsetBytes,
      limitBytes: args.pageLimitBytes,
      encoding: 'base64',
    },
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!observed.ok) {
    return {
      ok: false,
      aborted: observed.reasonCode === 'wait_aborted',
      message: observed.message,
    };
  }
  const page = observed.value.page;
  if (page === undefined) {
    return {
      ok: false,
      aborted: false,
      message: `host command ${args.stream} raw output page was missing.`,
    };
  }
  if (page === null) {
    const availableBytes =
      args.stream === 'stdout'
        ? observed.value.snapshot.stdoutBytes
        : observed.value.snapshot.stderrBytes;
    if (availableBytes > args.offsetBytes) {
      return {
        ok: false,
        aborted: false,
        message: `host command ${args.stream} raw output page was invalid.`,
      };
    }
    return {
      ok: true,
      content: Buffer.alloc(0),
      nextOffsetBytes: args.offsetBytes,
      hasMore: false,
      snapshot: observed.value.snapshot,
    };
  }
  const content = Buffer.from(page.content, 'base64');
  const expectedBytes = page.endOffsetBytes - page.offsetBytes;
  const expectedNextOffset = page.hasMore ? page.endOffsetBytes : null;
  if (
    page.contentEncoding !== 'base64' ||
    page.stream !== args.stream ||
    page.offsetBytes !== args.offsetBytes ||
    expectedBytes < 0 ||
    page.endOffsetBytes > page.totalBytes ||
    page.hasMore !== page.endOffsetBytes < page.totalBytes ||
    page.nextOffsetBytes !== expectedNextOffset ||
    content.length !== expectedBytes ||
    content.toString('base64') !== page.content ||
    (page.hasMore && expectedBytes === 0)
  ) {
    return {
      ok: false,
      aborted: false,
      message: `host command ${args.stream} raw output page was invalid.`,
    };
  }
  return {
    ok: true,
    content,
    nextOffsetBytes: page.endOffsetBytes,
    hasMore: page.hasMore,
    snapshot: observed.value.snapshot,
  };
}

async function waitForTerminalSnapshot(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  outputRef: string;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; snapshot: HostCommandSnapshot }
  | { ok: false; reasonCode: string; message: string }
> {
  const initial = await args.hostCommands.waitForInitialResult({
    stateRoot: args.stateRoot,
    outputRef: args.outputRef,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!initial.ok) {
    return {
      ok: false,
      reasonCode: initial.reasonCode,
      message: initial.message,
    };
  }
  let snapshot = initial.value;
  // 아직 안 끝났으면 revision 변화(=사건)를 기다려 이어붙인다 — 다음 사건이
  // terminal이면 그 스냅샷이 곧바로 돌아온다. 세션의 timeoutMs가 상한을 지키므로
  // 무한정 running으로 남지 않는다.
  while (snapshot.status === 'running') {
    const next = await args.hostCommands.interact({
      stateRoot: args.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: args.outputRef,
      afterRevision: snapshot.revision,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!next.ok) {
      return { ok: false, reasonCode: next.reasonCode, message: next.message };
    }
    snapshot = next.value.snapshot;
  }
  return { ok: true, snapshot };
}

async function readStream(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  outputRef: string;
  stream: HostCommandOutputStream;
  maxOutputBytes?: number;
  pageLimitBytes: number;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; content: string }
  | { ok: false; reasonCode: string; message: string }
> {
  let content = '';
  let offsetBytes = 0;
  for (;;) {
    const remainingBytes =
      args.maxOutputBytes === undefined
        ? args.pageLimitBytes
        : args.maxOutputBytes - offsetBytes;
    if (remainingBytes <= 0) {
      return { ok: true, content };
    }
    const limitBytes = Math.min(args.pageLimitBytes, remainingBytes);
    // 관찰 전용 interact — 부수효과가 없으므로 §4.7 operation 번호를 소모하지 않는다.
    const result = await args.hostCommands.interact({
      stateRoot: args.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: args.outputRef,
      yieldTimeMs: 0,
      page: { stream: args.stream, offsetBytes, limitBytes },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!result.ok) {
      return {
        ok: false,
        reasonCode: result.reasonCode,
        message: result.message,
      };
    }
    const page = result.value.page;
    if (page === undefined || page === null) {
      return {
        ok: false,
        reasonCode: 'output_store_failed',
        message: `host command ${args.stream} output page was missing.`,
      };
    }
    content += page.content;
    if (page.nextOffsetBytes === null) {
      return { ok: true, content };
    }
    if (page.nextOffsetBytes <= offsetBytes) {
      return {
        ok: false,
        reasonCode: 'output_store_failed',
        message: `host command ${args.stream} output page did not advance.`,
      };
    }
    offsetBytes = page.nextOffsetBytes;
  }
}
