import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  PUBLIC_HTTP_READ_PROTOCOL_VERSION,
  parsePublicHttpReadResult,
  type PublicHttpReadRequest,
} from '../command-host/public-http-read-protocol.js';
import { runHostRoutedSystemCommand } from './host-routed-command.js';
import type {
  PublicHttpReadOutcome,
  PublicHttpReadRuntime,
} from './utils/public-http-read-port.js';

interface PublicHttpReadWorkerCommand {
  execPath: string;
  args: readonly string[];
}

export function createHostRoutedPublicHttpReadRuntime(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  workerCommand?: PublicHttpReadWorkerCommand;
}): PublicHttpReadRuntime {
  return {
    async request(input) {
      const workerCommand =
        args.workerCommand ?? resolvePublicHttpReadWorkerCommand();
      if (workerCommand === undefined) {
        return failure(
          'host_unavailable',
          'public HTTP read host entrypoint is unavailable',
        );
      }
      const request: PublicHttpReadRequest = {
        version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
        url: input.url,
        method: input.method,
        headers: input.headers,
        responseBodyMode: input.responseBodyMode,
        ...(input.maxResponseBytes === undefined
          ? {}
          : { maxResponseBytes: input.maxResponseBytes }),
        ...(input.bodyBase64 === undefined
          ? {}
          : { bodyBase64: input.bodyBase64 }),
        ...(input.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.timeoutMs }),
      };
      const observed = await runHostRoutedSystemCommand({
        hostCommands: args.hostCommands,
        stateRoot: args.stateRoot,
        pageLimitBytes: args.pageLimitBytes,
        invocation: {
          executable: workerCommand.execPath,
          args: [...workerCommand.args],
          cwd: args.stateRoot,
          env: process.env,
          initialStdin: Buffer.from(JSON.stringify(request), 'utf8'),
          streamMode: 'lossless',
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      });
      if (!observed.ok) {
        return failure(
          observed.aborted ? 'aborted' : 'host_unavailable',
          observed.message,
        );
      }
      if (observed.snapshot.status !== 'exit') {
        return failure(
          observed.snapshot.status === 'timeout'
            ? 'timeout'
            : observed.snapshot.status === 'cancelled'
              ? 'aborted'
              : 'host_unavailable',
          `public HTTP read host ended with status ${observed.snapshot.status}`,
        );
      }
      if (observed.snapshot.exitCode !== 0) {
        return failure(
          'host_unavailable',
          `public HTTP read host exited with code ${String(
            observed.snapshot.exitCode,
          )}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(observed.stdout);
      } catch {
        return failure(
          'invalid_response',
          'public HTTP read host returned malformed output',
        );
      }
      const result = parsePublicHttpReadResult(parsed);
      if (result === undefined) {
        return failure(
          'invalid_response',
          'public HTTP read host returned an invalid result',
        );
      }
      const { version: _version, ...outcome } = result;
      return outcome;
    },
  };
}

function resolvePublicHttpReadWorkerCommand():
  | PublicHttpReadWorkerCommand
  | undefined {
  const sibling = fileURLToPath(
    new URL('../command-host/public-http-read-host-main.js', import.meta.url),
  );
  if (existsSync(sibling)) {
    return { execPath: process.execPath, args: [sibling] };
  }
  const bundleEntry = process.argv[1];
  if (bundleEntry === undefined) {
    return undefined;
  }
  const bundled = join(dirname(bundleEntry), 'public-http-read-host.mjs');
  return existsSync(bundled)
    ? { execPath: process.execPath, args: [bundled] }
    : undefined;
}

function failure(
  reasonCode: Extract<PublicHttpReadOutcome, { ok: false }>['reasonCode'],
  message: string,
): PublicHttpReadOutcome {
  return {
    ok: false,
    reasonCode,
    message,
  };
}
