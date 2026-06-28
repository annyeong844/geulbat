import { realpath } from 'node:fs/promises';

export function resolvePtcRuntimeRoot(args: {
  workspaceRoot: string;
  runtimeRootForWorkspace: ((workspaceRoot: string) => string) | undefined;
  runtimeLabel: string;
}): string {
  if (args.runtimeRootForWorkspace === undefined) {
    throw new Error(
      `PTC ${args.runtimeLabel} runtime root resolver is missing`,
    );
  }
  return args.runtimeRootForWorkspace(args.workspaceRoot);
}

export async function resolvePtcCanonicalWorkspaceRoot(args: {
  workspaceRoot: string;
  realpathWorkspaceRoot:
    | ((workspaceRoot: string) => Promise<string>)
    | undefined;
}): Promise<string> {
  return await (args.realpathWorkspaceRoot ?? resolvePtcWorkspaceRootRealpath)(
    args.workspaceRoot,
  );
}

export async function resolvePtcWorkspaceRootRealpath(
  workspaceRoot: string,
): Promise<string> {
  return await realpath(workspaceRoot);
}
