import type { SandboxAttemptStore } from './attempt-store.js';
import {
  createDisposableSandboxRoot,
  type DisposableSandboxRoot,
} from './disposable-root.js';

export async function withRunningSandboxAttemptRoot<T>(args: {
  attemptId: string;
  store: SandboxAttemptStore;
  onRootFailure(message: string): Promise<T> | T;
  run(root: DisposableSandboxRoot): Promise<T>;
}): Promise<T> {
  let root: DisposableSandboxRoot | null = null;
  try {
    root = await createDisposableSandboxRoot({
      attemptId: args.attemptId,
    });
    args.store.markRunning(args.attemptId, { rootPath: root.rootPath });
    return await args.run(root);
  } catch (error: unknown) {
    if (root === null) {
      return await args.onRootFailure(sandboxAttemptRootErrorMessage(error));
    }
    if (args.store.getAttempt(args.attemptId)?.status === 'running') {
      args.store.markTerminal(args.attemptId, {
        status: 'failed',
        diagnostics: 'sandbox_run_failed',
      });
    }
    throw error;
  } finally {
    await root?.cleanup();
  }
}

export function sandboxRootFailureDiagnostics(message: string): string {
  return `sandbox_root_failed: ${message}`;
}

function sandboxAttemptRootErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
