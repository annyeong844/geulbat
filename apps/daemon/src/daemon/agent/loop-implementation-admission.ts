import {
  AGENT_LOOP_IMPLEMENTATION_CONTRACT_VERSION,
  agentLoopKernelImplementation,
  type AgentLoopImplementation,
  type AgentLoopImplementationIdentity,
} from '@geulbat/agent-loop/kernel';
import type { ToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

export interface AgentLoopImplementationAdmissionInput {
  readonly runId: string;
  readonly threadId: string;
  readonly stateRoot: string;
  readonly modelConfiguration: {
    readonly providerId: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly serviceTier?: string;
  };
  readonly toolCapabilityPolicy?: ToolCapabilityPolicy;
  readonly requiredIdentity?: AgentLoopImplementationIdentity;
}

export type AgentLoopImplementationAdmissionResult =
  | {
      ok: true;
      identity: AgentLoopImplementationIdentity;
      implementation: AgentLoopImplementation;
      toolCapabilityPolicy?: ToolCapabilityPolicy;
    }
  | {
      ok: false;
      reason:
        | 'implementation_unavailable'
        | 'contract_incompatible'
        | 'tool_capability_policy_unavailable';
      implementationId: string;
      contractVersion?: string;
      supportedContractVersion: string;
      message: string;
    };

export interface AgentLoopImplementationAdmission {
  admitRun(
    input: AgentLoopImplementationAdmissionInput,
  ): Promise<AgentLoopImplementationAdmissionResult>;
}

interface CreateAgentLoopImplementationAdmissionOptions {
  additionalImplementations?: readonly AgentLoopImplementation[];
  selectImplementationId?: () => string;
}

export function createAgentLoopImplementationAdmission(
  options: CreateAgentLoopImplementationAdmissionOptions = {},
): AgentLoopImplementationAdmission {
  const implementations = new Map<string, AgentLoopImplementation>();
  for (const implementation of [
    agentLoopKernelImplementation,
    ...(options.additionalImplementations ?? []),
  ]) {
    if (implementations.has(implementation.implementationId)) {
      throw new Error(
        `duplicate agent loop implementation: ${implementation.implementationId}`,
      );
    }
    implementations.set(implementation.implementationId, implementation);
  }
  const selectImplementationId =
    options.selectImplementationId ??
    (() => agentLoopKernelImplementation.implementationId);

  return {
    async admitRun({ requiredIdentity }) {
      const implementationId =
        requiredIdentity?.implementationId ?? selectImplementationId();
      const implementation = implementations.get(implementationId);
      if (implementation === undefined) {
        return {
          ok: false,
          reason: 'implementation_unavailable',
          implementationId,
          ...(requiredIdentity === undefined
            ? {}
            : { contractVersion: requiredIdentity.contractVersion }),
          supportedContractVersion: AGENT_LOOP_IMPLEMENTATION_CONTRACT_VERSION,
          message: `agent loop implementation is unavailable: ${implementationId}`,
        };
      }
      const requiredContractVersion =
        requiredIdentity?.contractVersion ?? implementation.contractVersion;
      if (
        implementation.contractVersion !==
          AGENT_LOOP_IMPLEMENTATION_CONTRACT_VERSION ||
        requiredContractVersion !== implementation.contractVersion
      ) {
        return {
          ok: false,
          reason: 'contract_incompatible',
          implementationId,
          contractVersion: requiredContractVersion,
          supportedContractVersion: AGENT_LOOP_IMPLEMENTATION_CONTRACT_VERSION,
          message: `agent loop implementation contract is incompatible: ${implementationId}@${requiredContractVersion}; registered ${implementation.contractVersion}, host requires ${AGENT_LOOP_IMPLEMENTATION_CONTRACT_VERSION}`,
        };
      }
      return {
        ok: true,
        identity: Object.freeze({
          implementationId: implementation.implementationId,
          contractVersion: implementation.contractVersion,
        }),
        implementation,
      };
    },
  };
}
