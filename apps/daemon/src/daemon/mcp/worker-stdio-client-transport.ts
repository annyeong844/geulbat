import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { HostCommandRuntime } from '../../command-host/contract.js';
import { getErrorMessage } from '../utils/error.js';
import { runDetached } from '../utils/run-detached.js';

// P7.6 §4 A안 — MCP 서버 프로세스를 command-host 세션에 두고, 이 전송은
// **바이트만 중계**한다. MCP 프로토콜 소유(핸드셰이크·요청 매칭·스키마 검증)는
// 데몬의 SDK client에 그대로 남는다. codex의 executor transport와 같은 분업이다:
// "The executor only owns the process."
//
// 그래서 이 파일에는 spawn도, 프로세스 트리 종료도, stderr 펌프도 없다. 그것들은
// 워커의 일이고, 여기서는 세션이 죽으면 값으로 도착한다.

interface WorkerStdioLaunchSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

interface WorkerStdioClientTransportOptions {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  /**
   * 한 번에 읽어올 페이지 크기. 세션 계약이 inline 예산을 넘는 페이지를
   * 거절하므로 호출자가 자기 예산을 넘긴다 — 이 모듈이 숫자를 고르지 않는다.
   */
  maxPageBytes: number;
}

/**
 * 세션 하나의 바이트 스트림에 붙는 MCP 전송.
 *
 * `launch`는 새 서버를 세우고, `attach`는 **이미 살아 있는 세션**에 다시 붙는다
 * (P7.6 §7.2 재입양). attach에서는 `sessionId`가 설정되므로 SDK가 두 번째
 * `initialize`를 보내지 않는다 — 살아 있는 MCP 세션의 규범이 그렇다.
 */
export class WorkerStdioClientTransport implements Transport {
  private readonly options: WorkerStdioClientTransportOptions;
  private readonly launchSpec: WorkerStdioLaunchSpec | undefined;
  private readonly readBuffer = new ReadBuffer();
  private outputRef: string | undefined;
  private readOffset = 0;
  private closing = false;
  private started = false;
  /** 읽기 루프가 실제로 멈춘 시점 — 떠나는 쪽은 이것을 기다려야 한다. */
  private readLoopDone: Promise<void> | undefined;
  /** 떠날 때 진행 중인 관측 대기를 끊는다. 그러지 않으면 대기 상한만큼 붙잡힌다. */
  private readonly readAbort = new AbortController();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  /** SDK 재접속 규범 — 설정돼 있으면 connect()가 핸드셰이크를 건너뛴다. */
  sessionId?: string;

  private constructor(
    options: WorkerStdioClientTransportOptions,
    source:
      | { kind: 'launch'; spec: WorkerStdioLaunchSpec }
      | { kind: 'attach'; outputRef: string; readOffset: number },
  ) {
    this.options = options;
    if (source.kind === 'launch') {
      this.launchSpec = source.spec;
    } else {
      this.launchSpec = undefined;
      this.outputRef = source.outputRef;
      this.readOffset = source.readOffset;
      this.sessionId = source.outputRef;
    }
  }

  static launch(
    options: WorkerStdioClientTransportOptions,
    spec: WorkerStdioLaunchSpec,
  ): WorkerStdioClientTransport {
    return new WorkerStdioClientTransport(options, { kind: 'launch', spec });
  }

  static attach(
    options: WorkerStdioClientTransportOptions,
    session: { outputRef: string; readOffset: number },
  ): WorkerStdioClientTransport {
    return new WorkerStdioClientTransport(options, {
      kind: 'attach',
      outputRef: session.outputRef,
      readOffset: session.readOffset,
    });
  }

  /** 재입양에 필요한 좌표 — 데몬이 죽어도 이것만 있으면 다시 붙는다. */
  get session(): { outputRef: string; readOffset: number } | undefined {
    return this.outputRef === undefined
      ? undefined
      : { outputRef: this.outputRef, readOffset: this.readOffset };
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('worker stdio transport can only be started once');
    }
    this.started = true;
    if (this.launchSpec !== undefined) {
      const started = await this.options.hostCommands.start({
        executable: this.launchSpec.executable,
        args: [...this.launchSpec.args],
        cwd: this.launchSpec.cwd,
        env: this.launchSpec.env,
        stateRoot: this.options.stateRoot,
        threadId: '',
        owner: 'system',
        streamMode: 'protocol',
        runId: 'mcp',
        callId: 'mcp',
        stdinMode: 'open',
      });
      if (!started.ok) {
        throw new Error(
          `MCP server session could not start: ${started.message}`,
        );
      }
      this.outputRef = started.outputRef;
      // 새 세션이므로 핸드셰이크가 필요하다 — sessionId를 두지 않는다.
      delete this.sessionId;
      // claim해야 데몬 연결이 끊겨도 세션이 살아남는다 (P7.5 §4.2).
      await this.options.hostCommands.waitForInitialResult({
        stateRoot: this.options.stateRoot,
        outputRef: started.outputRef,
        yieldTimeMs: 0,
      });
    }
    this.readLoopDone = this.readLoop();
    runDetached(
      'mcp/worker-stdio-read',
      () => this.readLoopDone ?? Promise.resolve(),
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const outputRef = this.requireSession();
    const written = await this.options.hostCommands.interact({
      stateRoot: this.options.stateRoot,
      threadId: '',
      owner: 'system',
      outputRef,
      chars: serializeMessage(message),
      yieldTimeMs: 0,
    });
    if (!written.ok) {
      throw new Error(`MCP server session refused a write: ${written.message}`);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.readAbort.abort();
    await this.readLoopDone;
    const outputRef = this.outputRef;
    if (outputRef !== undefined) {
      await this.options.hostCommands.interact({
        stateRoot: this.options.stateRoot,
        threadId: '',
        owner: 'system',
        outputRef,
        terminate: true,
        yieldTimeMs: 0,
      });
    }
    this.onclose?.();
  }

  /**
   * 세션을 남겨둔 채 이 클라이언트만 떠난다 — 데몬 종료가 "앱 종료"가 아닐
   * 때의 경로다(P7.6 §7.1). 프로세스는 워커에 그대로 남는다.
   *
   * 읽기 루프가 멈출 때까지 기다린다. 떠나는 리더가 한 번 더 읽으면 그
   * 바이트는 이미 건네진 것으로 처리되어(§5.2 release) 다음 리더가 보지
   * 못한다 — 재입양이 바로 그 다음 리더다.
   */
  async detach(): Promise<void> {
    this.closing = true;
    this.readAbort.abort();
    await this.readLoopDone;
    this.onclose?.();
  }

  private requireSession(): string {
    const outputRef = this.outputRef;
    if (outputRef === undefined) {
      throw new Error('worker stdio transport is not connected');
    }
    return outputRef;
  }

  private async readLoop(): Promise<void> {
    // 아직 덜 읽은 페이지가 남았으면 기다리지 않는다. 그렇지 않으면 세션의
    // 대기 상한(§4.6)에 맡긴다 — 변화가 오면 즉시 깨므로 폴링이 아니다.
    let drain = false;
    while (!this.closing) {
      const outputRef = this.outputRef;
      if (outputRef === undefined) {
        return;
      }
      const observed = await this.options.hostCommands.interact({
        stateRoot: this.options.stateRoot,
        threadId: '',
        owner: 'system',
        outputRef,
        ...(drain ? { yieldTimeMs: 0 } : {}),
        signal: this.readAbort.signal,
        page: {
          stream: 'stdout',
          offsetBytes: this.readOffset,
          limitBytes: this.options.maxPageBytes,
        },
      });
      if (this.closing) {
        return;
      }
      if (!observed.ok) {
        this.onerror?.(
          new Error(`MCP server session read failed: ${observed.message}`),
        );
        this.onclose?.();
        return;
      }
      const page = observed.value.page;
      drain = page?.hasMore === true;
      if (page !== null && page.endOffsetBytes > this.readOffset) {
        this.readOffset = page.endOffsetBytes;
        this.deliver(Buffer.from(page.content, 'utf8'));
      }
      if (observed.value.snapshot.status !== 'running') {
        // 서버가 끝났다 — 이것은 값이지 데몬의 사건이 아니다.
        this.onclose?.();
        return;
      }
    }
  }

  private deliver(chunk: Buffer): void {
    this.readBuffer.append(chunk);
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error: unknown) {
        this.onerror?.(new Error(getErrorMessage(error)));
        return;
      }
      if (message === null) {
        return;
      }
      this.onmessage?.(message);
    }
  }
}
