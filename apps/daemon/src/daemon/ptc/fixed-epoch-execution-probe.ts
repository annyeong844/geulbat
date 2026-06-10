import { writeFile } from 'node:fs/promises';
import { dirname, join, posix as pathPosix } from 'node:path';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import type {
  PtcEpochCallbackHandler,
  PtcEpochCallbackHandlerInvocation,
} from './epoch-callback.js';
import {
  createPtcSessionEpochBridge,
  type CreatePtcSessionEpochBridgeArgs,
  type PtcSessionEpochBridge,
  type PtcSessionEpochBridgeResult,
} from './session-epoch-bridge.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';
import { runPtcSessionDockerCommand } from './session-docker-command.js';
import { applyPtcHostPathMode } from './host-path-mode.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
  type PtcFixedEpochExecutionProbeResult,
  type PtcFixedEpochExecutionProbeSummary,
  type PtcFixedProbeDiagnostics,
} from './fixed-probe-runtime-contract.js';

const MAX_PROBE_STDOUT_BYTES = 16 * 1024;

export const PTC_FIXED_EPOCH_EXECUTION_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const net = require('node:net');

const inputPath = process.argv[1];
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function writeResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (
  input?.schemaVersion !== 1 ||
  typeof input.socketPath !== 'string' ||
  typeof input.token !== 'string' ||
  input.requestId !== 'ptc-fixed-probe-1'
) {
  writeResult({ ok: false, errorCode: 'probe_input_invalid' });
  process.exit(0);
}

const socket = net.createConnection(input.socketPath);
let buffer = '';
let settled = false;

const done = (result) => {
  if (settled) {
    return;
  }
  settled = true;
  writeResult(result);
  socket.destroy();
};

socket.setEncoding('utf8');
socket.on('connect', () => {
  socket.write(JSON.stringify({
    requestId: input.requestId,
    token: input.token,
    kind: 'ptc_fixed_probe_echo',
    args: { message: 'ping' },
  }) + '\n');
});
socket.on('data', (chunk) => {
  buffer += chunk;
  const newlineIndex = buffer.indexOf('\n');
  if (newlineIndex < 0) {
    return;
  }
  const line = buffer.slice(0, newlineIndex);
  try {
    const response = JSON.parse(line);
    if (response.ok === true) {
      const resultKind =
        response.result && typeof response.result === 'object' && 'kind' in response.result
          ? response.result.kind
          : 'other';
      done({ ok: true, callbackResultKind: resultKind });
      return;
    }
    done({
      ok: false,
      errorCode: response.errorCode || 'callback_failed',
      message: response.message || 'PTC callback failed',
    });
  } catch {
    done({ ok: false, errorCode: 'callback_response_invalid' });
  }
});
socket.on('error', () => {
  done({ ok: false, errorCode: 'callback_connection_failed' });
});
`;

export type PtcSessionEpochBridgeFactory = (
  args: CreatePtcSessionEpochBridgeArgs,
) => Promise<PtcSessionEpochBridgeResult<PtcSessionEpochBridge>>;

export interface RunPtcFixedEpochExecutionProbeArgs {
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  bridgeFactory?: PtcSessionEpochBridgeFactory;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runPtcFixedEpochExecutionProbe(
  args: RunPtcFixedEpochExecutionProbeArgs,
): Promise<
  PtcFixedEpochExecutionProbeResult<PtcFixedEpochExecutionProbeSummary>
> {
  let bridgeResult: PtcSessionEpochBridgeResult<PtcSessionEpochBridge>;
  try {
    bridgeResult = await (args.bridgeFactory ?? createPtcSessionEpochBridge)({
      identity: args.identity,
      sessionManager: args.sessionManager,
      callbackHandler: fixedProbeCallbackHandler,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch {
    return {
      ok: false,
      reasonCode: 'bridge_unavailable',
      message: 'PTC fixed epoch execution probe bridge is unavailable',
      diagnostics: { bridgeReasonCode: 'bridge_factory_threw' },
    };
  }

  if (!bridgeResult.ok) {
    return {
      ok: false,
      reasonCode: 'bridge_unavailable',
      message: 'PTC fixed epoch execution probe bridge is unavailable',
      diagnostics: { bridgeReasonCode: bridgeResult.reasonCode },
    };
  }

  const bridge = bridgeResult.value;
  try {
    const inputPaths = getProbeInputPaths(bridge);
    const input = {
      schemaVersion: 1,
      socketPath: bridge.callbackSocketContainerPath,
      token: bridge.token,
      requestId: 'ptc-fixed-probe-1',
    };

    try {
      await writeFile(inputPaths.hostPath, JSON.stringify(input), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await applyPtcHostPathMode({
        path: inputPaths.hostPath,
        pathKind: 'ptc_fixed_epoch_probe_input',
        mode: 0o600,
      });
    } catch {
      return {
        ok: false,
        reasonCode: 'probe_input_write_failed',
        message: 'PTC fixed epoch execution probe input write failed',
      };
    }

    let execution: PtcSessionDockerCommandResult;
    try {
      execution = await (args.commandRunner ?? runPtcSessionDockerCommand)({
        executable: args.dockerPath ?? 'docker',
        args: [
          'exec',
          bridge.containerId,
          'node',
          '-e',
          PTC_FIXED_EPOCH_EXECUTION_PROBE_SCRIPT,
          inputPaths.containerPath,
        ],
        timeoutMs: args.timeoutMs ?? 5_000,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch {
      return {
        ok: false,
        reasonCode: 'execution_failed',
        message: 'PTC fixed epoch execution probe failed to execute',
        diagnostics: sanitizeCommandDiagnostics({ kind: 'thrown' }),
      };
    }

    if (execution.kind !== 'exit' || execution.exitCode !== 0) {
      return {
        ok: false,
        reasonCode: 'execution_failed',
        message: 'PTC fixed epoch execution probe failed to execute',
        diagnostics: sanitizeCommandDiagnostics(execution),
      };
    }

    const parsed = parseProbeStdout(execution.stdout);
    if (!parsed.ok) {
      return parsed;
    }

    return {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
        policyId: PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
        executionClass: 'fixed_docker_exec_probe',
        executionSurface: 'baked_image_node_eval',
        containerId: bridge.containerId,
        epochId: bridge.epochId,
        callbackRoundTrip: 'observed',
        callbackResultKind: parsed.value.callbackResultKind,
        exitCode: 0,
      },
    };
  } finally {
    await bridge.close().catch(() => {});
  }
}

function getProbeInputPaths(bridge: PtcSessionEpochBridge): {
  hostPath: string;
  containerPath: string;
} {
  return {
    hostPath: join(
      dirname(bridge.callbackSocketHostPath),
      'fixed-probe-input.json',
    ),
    containerPath: `${pathPosix.dirname(bridge.callbackSocketContainerPath)}/fixed-probe-input.json`,
  };
}

const fixedProbeCallbackHandler: PtcEpochCallbackHandler = async (
  invocation: PtcEpochCallbackHandlerInvocation,
) => {
  if (
    invocation.kind !== 'ptc_fixed_probe_echo' ||
    !isRecord(invocation.args) ||
    invocation.args.message !== 'ping'
  ) {
    return {
      ok: false,
      errorCode: 'fixed_probe_request_invalid',
      message: 'PTC fixed probe callback request is invalid',
    };
  }
  return { ok: true, result: { kind: 'inline', value: 'pong' } };
};

function parseProbeStdout(stdout: string): PtcFixedEpochExecutionProbeResult<{
  callbackResultKind: PtcFixedEpochExecutionProbeSummary['callbackResultKind'];
}> {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_PROBE_STDOUT_BYTES) {
    return {
      ok: false,
      reasonCode: 'probe_output_invalid',
      message: 'PTC fixed epoch execution probe stdout is too large',
    };
  }

  const trimmed = stdout.trim();
  if (trimmed.includes('\n')) {
    return {
      ok: false,
      reasonCode: 'probe_output_invalid',
      message: 'PTC fixed epoch execution probe stdout must be one JSON line',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      reasonCode: 'probe_output_invalid',
      message: 'PTC fixed epoch execution probe stdout is not valid JSON',
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reasonCode: 'probe_output_invalid',
      message: 'PTC fixed epoch execution probe stdout is not an object',
    };
  }

  if (parsed.ok !== true) {
    return {
      ok: false,
      reasonCode: 'probe_result_failed',
      message:
        'PTC fixed epoch execution probe reported a failed callback result',
      ...(typeof parsed.errorCode === 'string'
        ? { diagnostics: { probeErrorCode: parsed.errorCode } }
        : {}),
    };
  }

  const kind =
    parsed.callbackResultKind === 'inline' ||
    parsed.callbackResultKind === 'offloaded' ||
    parsed.callbackResultKind === 'other'
      ? parsed.callbackResultKind
      : 'other';
  return { ok: true, value: { callbackResultKind: kind } };
}

function sanitizeCommandDiagnostics(
  result: PtcSessionDockerCommandResult | { kind: 'thrown' },
): PtcFixedProbeDiagnostics {
  return {
    commandResultKind: result.kind,
    ...(result.kind === 'exit' ? { exitCode: result.exitCode } : {}),
  };
}
