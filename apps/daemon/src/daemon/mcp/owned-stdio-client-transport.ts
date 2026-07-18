import type { ChildProcess } from 'node:child_process';
import process from 'node:process';
import { PassThrough } from 'node:stream';

import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import spawn from 'cross-spawn';

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const TREE_SETTLEMENT_POLL_MS = 20;

type TransportState =
  | 'idle'
  | 'starting'
  | 'live'
  | 'closing'
  | 'failed'
  | 'settled';

type SettlementReason = 'requested' | 'unexpected-exit';

export interface OwnedStdioClientTransportOptions {
  command: string;
  args?: readonly string[];
  env: Record<string, string>;
  cwd?: string;
  shutdownGraceMs?: number;
}

/**
 * MCP-only stdio transport that retains ownership until the server process tree
 * is settled. POSIX children run as process-group leaders; Windows teardown uses
 * taskkill's tree mode and remains subject to the native Windows proof tracked
 * by the global MCP specification.
 */
export class OwnedStdioClientTransport implements Transport {
  private readonly options: OwnedStdioClientTransportOptions;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream = new PassThrough();
  private state: TransportState = 'idle';
  private child: ChildProcess | undefined;
  private leaderPid: number | undefined;
  private leaderClosed = false;
  private closeNotificationSent = false;
  private activeSettlement: Promise<void> | undefined;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  constructor(options: OwnedStdioClientTransportOptions) {
    this.options = options;
  }

  get stderr(): PassThrough {
    return this.stderrStream;
  }

  get pid(): number | null {
    return this.leaderPid ?? null;
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error('Owned MCP stdio transport can only be started once');
    }
    this.state = 'starting';
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      detached: process.platform !== 'win32',
      env: this.options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    this.child = child;
    this.leaderPid = child.pid;
    this.attachProcessStreams(child);

    await new Promise<void>((resolve, reject) => {
      let startSettled = false;
      child.once('spawn', () => {
        startSettled = true;
        this.state = 'live';
        resolve();
      });
      child.once('error', (error) => {
        this.onerror?.(error);
        if (!startSettled) {
          this.state = 'failed';
          reject(error);
        }
      });
    });
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.state !== 'live' || !stdin?.writable) {
      throw new Error('Owned MCP stdio transport is not connected');
    }
    const serialized = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      stdin.write(serialized, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await this.beginSettlement('requested');
  }

  private attachProcessStreams(child: ChildProcess): void {
    child.stdin?.on('error', (error) => {
      if (this.state !== 'closing' && this.state !== 'settled') {
        this.onerror?.(error);
      }
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.processReadBuffer();
    });
    child.stdout?.on('error', (error) => {
      this.onerror?.(error);
    });
    child.stderr?.pipe(this.stderrStream);
    child.once('exit', () => {
      if (this.activeSettlement === undefined && this.state !== 'settled') {
        void this.beginSettlement('unexpected-exit').catch((error: unknown) => {
          this.onerror?.(toError(error));
        });
      }
    });
    child.once('close', () => {
      this.leaderClosed = true;
    });
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          return;
        }
        this.onmessage?.(message);
      } catch (error: unknown) {
        this.onerror?.(toError(error));
      }
    }
  }

  private beginSettlement(reason: SettlementReason): Promise<void> {
    if (this.state === 'settled') {
      return Promise.resolve();
    }
    if (this.activeSettlement !== undefined) {
      return this.activeSettlement;
    }
    this.state = 'closing';
    const settlement = this.settleProcessTree(reason)
      .then(() => {
        this.state = 'settled';
        this.child = undefined;
        this.leaderPid = undefined;
        this.readBuffer.clear();
      })
      .catch((error: unknown) => {
        this.state = 'failed';
        this.activeSettlement = undefined;
        throw error;
      })
      .finally(() => {
        this.notifyClosed();
      });
    this.activeSettlement = settlement;
    return settlement;
  }

  private async settleProcessTree(reason: SettlementReason): Promise<void> {
    const child = this.child;
    const pid = this.leaderPid;
    if (!child || pid === undefined) {
      return;
    }
    const graceMs = this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

    if (reason === 'requested') {
      child.stdin?.end();
      if (await this.waitForTreeSettlement(pid, graceMs)) {
        return;
      }
    }

    const gracefulError = await this.signalTree(pid, false, graceMs);
    if (await this.waitForTreeSettlement(pid, graceMs)) {
      return;
    }
    const forceError = await this.signalTree(pid, true, graceMs);
    if (await this.waitForTreeSettlement(pid, graceMs)) {
      return;
    }

    const diagnostics = [gracefulError, forceError]
      .filter((error): error is Error => error !== undefined)
      .map((error) => error.message)
      .join('; ');
    throw new Error(
      `MCP stdio process tree did not settle for pid ${pid}${
        diagnostics.length === 0 ? '' : `: ${diagnostics}`
      }`,
    );
  }

  private async signalTree(
    pid: number,
    force: boolean,
    graceMs: number,
  ): Promise<Error | undefined> {
    try {
      if (process.platform === 'win32') {
        await runWindowsTaskkill(pid, force, graceMs);
      } else {
        signalPosixProcessGroup(pid, force ? 'SIGKILL' : 'SIGTERM');
      }
      return undefined;
    } catch (error: unknown) {
      return toError(error);
    }
  }

  private async waitForTreeSettlement(
    pid: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.isTreeSettled(pid)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      await delay(Math.min(TREE_SETTLEMENT_POLL_MS, remainingMs));
    }
    return true;
  }

  private isTreeSettled(pid: number): boolean {
    if (process.platform === 'win32') {
      return this.leaderClosed;
    }
    return this.leaderClosed && !isPosixProcessGroupAlive(pid);
  }

  private notifyClosed(): void {
    if (this.closeNotificationSent) {
      return;
    }
    this.closeNotificationSent = true;
    this.onclose?.();
  }
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (!isErrorWithCode(error, 'ESRCH')) {
      throw error;
    }
  }
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if (isErrorWithCode(error, 'ESRCH')) {
      return false;
    }
    if (isErrorWithCode(error, 'EPERM')) {
      return true;
    }
    throw error;
  }
}

async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  timeoutMs: number,
): Promise<void> {
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
  const taskkill = spawn('taskkill.exe', args, {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      taskkill.kill('SIGKILL');
      finish(() => {
        reject(new Error(`taskkill timed out for MCP process tree ${pid}`));
      });
    }, timeoutMs);
    taskkill.once('error', (error) => {
      finish(() => reject(error));
    });
    taskkill.once('close', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `taskkill failed for MCP process tree ${pid} (code=${String(
              code,
            )}, signal=${String(signal)})`,
          ),
        );
      });
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: unknown }).code === code
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
