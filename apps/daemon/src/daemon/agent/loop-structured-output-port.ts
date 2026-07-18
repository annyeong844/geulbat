import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type { FunctionCall, ProviderStructuredOutput } from '../llm/index.js';
import type { RunContext } from '../run-context.js';
import type { AgentResult } from './agent-result.js';
import {
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
  runPtcFixedProbeStructuredOutputCaller,
} from './ptc-fixed-probe-structured-output-caller.js';
import { runReactBundleStructuredOutputCaller } from './react-bundle-structured-output-caller.js';

interface ProcessAgentLoopStructuredOutputsArgs {
  runContext: RunContext;
  structuredOutputs: ProviderStructuredOutput[];
  functionCalls: FunctionCall[];
  signal: AbortSignal | undefined;
}

type AgentLoopStructuredOutputResult =
  | { ok: true; handled: false }
  | { ok: true; handled: true; result: AgentResult }
  | { ok: false; message: string };

export interface AgentLoopStructuredOutputPort {
  processStructuredOutputs(
    args: ProcessAgentLoopStructuredOutputsArgs,
  ): Promise<AgentLoopStructuredOutputResult>;
}

export function createAgentLoopStructuredOutputPort(
  runtimeServices: AgentRuntimeServices,
): AgentLoopStructuredOutputPort {
  return {
    async processStructuredOutputs(args) {
      if (args.structuredOutputs.length === 0) {
        return { ok: true, handled: false };
      }

      const firstStructuredOutput = args.structuredOutputs[0];
      const structuredResult =
        firstStructuredOutput?.kind === PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND
          ? await runPtcFixedProbeStructuredOutputCaller({
              runContext: args.runContext,
              runtime: runtimeServices.ptcFixedProbe,
              structuredOutputs: args.structuredOutputs,
              functionCalls: args.functionCalls,
              ...(args.signal === undefined ? {} : { signal: args.signal }),
            })
          : await runReactBundleStructuredOutputCaller({
              workspaceRoot: args.runContext.stateRoot,
              store: runtimeServices.sandboxAttempts,
              structuredOutputs: args.structuredOutputs,
              functionCalls: args.functionCalls,
              ingressPolicy:
                runtimeServices.reactBundleStructuredOutputIngressPolicy,
              ...(args.signal === undefined ? {} : { signal: args.signal }),
            });

      if (!structuredResult.ok) {
        return { ok: false, message: structuredResult.message };
      }

      return {
        ok: true,
        handled: true,
        result: structuredResult.result,
      };
    },
  };
}
