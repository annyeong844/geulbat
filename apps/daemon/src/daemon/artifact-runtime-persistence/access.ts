import {
  resolveRuntimeStateTarget,
  type RuntimeStateTarget,
} from '../runtime-persistence-file-access.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import type { ArtifactRuntimePersistenceScopeRequest } from './contract.js';

const runPersistenceSerial = createKeyedSerialRunner();
const runPersistenceWorkspaceSerial = createKeyedSerialRunner();

export async function resolveRuntimePersistenceTarget(
  workspaceRoot: string,
  scope: ArtifactRuntimePersistenceScopeRequest,
): Promise<{
  target: RuntimeStateTarget;
  filePath: string;
}> {
  const target = await resolveRuntimeStateTarget(workspaceRoot, scope);
  return {
    target,
    filePath: target.absolutePath,
  };
}

export async function withRuntimePersistenceLock<T>(
  workspaceRoot: string,
  filePath: string,
  action: () => Promise<T>,
): Promise<T> {
  return runPersistenceWorkspaceSerial(workspaceRoot, async () => {
    return runPersistenceSerial(filePath, action);
  });
}
