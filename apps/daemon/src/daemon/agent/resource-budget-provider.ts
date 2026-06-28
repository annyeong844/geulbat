import { randomUUID } from 'node:crypto';
import {
  availableParallelism,
  freemem as readHostFreeMemoryBytes,
  totalmem as readHostTotalMemoryBytes,
} from 'node:os';

import type { ToolRunState } from '../runtime-contracts.js';
import { countActiveBackgroundChildren } from './runtime/run-state.js';

export type ResourceBudgetObservationSource =
  | 'node_os_available_parallelism'
  | 'node_os_memory'
  | 'node_process_available_memory'
  | 'node_process_constrained_memory'
  | 'run_state_background_children';

export type ResourceBudgetMeasurement<TValue> =
  | {
      ok: true;
      value: TValue;
      source: ResourceBudgetObservationSource;
      confidence: 'trusted' | 'advisory';
    }
  | {
      ok: false;
      source: ResourceBudgetObservationSource;
      confidence: 'unavailable';
      reasonCode: 'unavailable' | 'invalid';
      message: string;
    };

export type ResourceBudgetMemoryPrecedence =
  | 'daemon_cgroup_limit'
  | 'host_os_context_only'
  | 'unavailable';

export interface ResourceBudgetSnapshot {
  snapshotId: string;
  capturedAt: string;
  cpu: {
    availableParallelism: ResourceBudgetMeasurement<number>;
  };
  memory: {
    hostTotalBytes: ResourceBudgetMeasurement<number>;
    hostFreeBytes: ResourceBudgetMeasurement<number>;
    daemonConstrainedMemoryBytes: ResourceBudgetMeasurement<number>;
    daemonAvailableMemoryBytes: ResourceBudgetMeasurement<number>;
    precedence: ResourceBudgetMemoryPrecedence;
  };
  subagents: {
    activeBackgroundChildren: ResourceBudgetMeasurement<number>;
  };
}

export interface ResourceBudgetProvider {
  captureSnapshot(args?: { runState?: ToolRunState }): ResourceBudgetSnapshot;
}

interface ResourceBudgetObservationReader {
  createSnapshotId(): string;
  now(): string;
  readAvailableParallelism(): number | undefined;
  readHostTotalMemoryBytes(): number | undefined;
  readHostFreeMemoryBytes(): number | undefined;
  readDaemonConstrainedMemoryBytes(): number | undefined;
  readDaemonAvailableMemoryBytes(): number | undefined;
}

export function createResourceBudgetProvider(
  options: {
    reader?: ResourceBudgetObservationReader;
  } = {},
): ResourceBudgetProvider {
  const reader = options.reader ?? createDefaultResourceBudgetReader();

  return {
    captureSnapshot(args = {}) {
      const { runState } = args;
      const hostTotalBytes = readPositiveSafeIntegerMeasurement({
        source: 'node_os_memory',
        label: 'host total memory bytes',
        confidence: 'advisory',
        read: reader.readHostTotalMemoryBytes,
      });
      const daemonConstrainedMemoryBytes = readPositiveSafeIntegerMeasurement({
        source: 'node_process_constrained_memory',
        label: 'daemon constrained memory bytes',
        confidence: 'trusted',
        read: reader.readDaemonConstrainedMemoryBytes,
      });

      return {
        snapshotId: reader.createSnapshotId(),
        capturedAt: reader.now(),
        cpu: {
          availableParallelism: readPositiveSafeIntegerMeasurement({
            source: 'node_os_available_parallelism',
            label: 'available parallelism',
            confidence: 'trusted',
            read: reader.readAvailableParallelism,
          }),
        },
        memory: {
          hostTotalBytes,
          hostFreeBytes: readPositiveSafeIntegerMeasurement({
            source: 'node_os_memory',
            label: 'host free memory bytes',
            confidence: 'advisory',
            read: reader.readHostFreeMemoryBytes,
          }),
          daemonConstrainedMemoryBytes,
          daemonAvailableMemoryBytes: readPositiveSafeIntegerMeasurement({
            source: 'node_process_available_memory',
            label: 'daemon available memory bytes',
            confidence: 'trusted',
            read: reader.readDaemonAvailableMemoryBytes,
          }),
          precedence: resolveMemoryPrecedence({
            hostTotalBytes,
            daemonConstrainedMemoryBytes,
          }),
        },
        subagents: {
          activeBackgroundChildren:
            runState === undefined
              ? buildUnavailableMeasurement({
                  source: 'run_state_background_children',
                  label: 'active background children',
                })
              : readNonNegativeSafeIntegerMeasurement({
                  source: 'run_state_background_children',
                  label: 'active background children',
                  confidence: 'trusted',
                  read: () => countActiveBackgroundChildren(runState),
                }),
        },
      };
    },
  };
}

function createDefaultResourceBudgetReader(): ResourceBudgetObservationReader {
  return {
    createSnapshotId: randomUUID,
    now: () => new Date().toISOString(),
    readAvailableParallelism: availableParallelism,
    readHostTotalMemoryBytes,
    readHostFreeMemoryBytes,
    readDaemonConstrainedMemoryBytes() {
      return typeof process.constrainedMemory === 'function'
        ? process.constrainedMemory()
        : undefined;
    },
    readDaemonAvailableMemoryBytes() {
      return typeof process.availableMemory === 'function'
        ? process.availableMemory()
        : undefined;
    },
  };
}

function readPositiveSafeIntegerMeasurement(args: {
  source: ResourceBudgetObservationSource;
  label: string;
  confidence: 'trusted' | 'advisory';
  read: () => number | undefined;
}): ResourceBudgetMeasurement<number> {
  return readIntegerMeasurement({
    ...args,
    minValue: 1,
  });
}

function readNonNegativeSafeIntegerMeasurement(args: {
  source: ResourceBudgetObservationSource;
  label: string;
  confidence: 'trusted' | 'advisory';
  read: () => number | undefined;
}): ResourceBudgetMeasurement<number> {
  return readIntegerMeasurement({
    ...args,
    minValue: 0,
  });
}

function readIntegerMeasurement(args: {
  source: ResourceBudgetObservationSource;
  label: string;
  confidence: 'trusted' | 'advisory';
  minValue: number;
  read: () => number | undefined;
}): ResourceBudgetMeasurement<number> {
  let value: number | undefined;
  try {
    value = args.read();
  } catch (error: unknown) {
    return {
      ok: false,
      source: args.source,
      confidence: 'unavailable',
      reasonCode: 'unavailable',
      message: `${args.label} unavailable: ${String(error)}`,
    };
  }

  if (value === undefined) {
    return buildUnavailableMeasurement({
      source: args.source,
      label: args.label,
    });
  }
  if (!Number.isSafeInteger(value) || value < args.minValue) {
    return {
      ok: false,
      source: args.source,
      confidence: 'unavailable',
      reasonCode: 'invalid',
      message: `${args.label} invalid: ${String(value)}`,
    };
  }

  return {
    ok: true,
    value,
    source: args.source,
    confidence: args.confidence,
  };
}

function buildUnavailableMeasurement(args: {
  source: ResourceBudgetObservationSource;
  label: string;
}): ResourceBudgetMeasurement<number> {
  return {
    ok: false,
    source: args.source,
    confidence: 'unavailable',
    reasonCode: 'unavailable',
    message: `${args.label} unavailable`,
  };
}

function resolveMemoryPrecedence(args: {
  hostTotalBytes: ResourceBudgetMeasurement<number>;
  daemonConstrainedMemoryBytes: ResourceBudgetMeasurement<number>;
}): ResourceBudgetMemoryPrecedence {
  if (args.daemonConstrainedMemoryBytes.ok) {
    return 'daemon_cgroup_limit';
  }
  if (args.hostTotalBytes.ok) {
    return 'host_os_context_only';
  }
  return 'unavailable';
}
