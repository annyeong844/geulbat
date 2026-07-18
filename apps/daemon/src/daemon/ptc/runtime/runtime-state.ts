import { realpath } from 'node:fs/promises';

export function resolvePtcRuntimeRoot(args: {
  stateRoot: string;
  runtimeRootForState: ((stateRoot: string) => string) | undefined;
  runtimeLabel: string;
}): string {
  if (args.runtimeRootForState === undefined) {
    throw new Error(
      `PTC ${args.runtimeLabel} runtime root resolver is missing`,
    );
  }
  return args.runtimeRootForState(args.stateRoot);
}

export async function resolvePtcCanonicalStateRoot(args: {
  stateRoot: string;
  realpathStateRoot: ((stateRoot: string) => Promise<string>) | undefined;
}): Promise<string> {
  return await (args.realpathStateRoot ?? resolvePtcStateRootRealpath)(
    args.stateRoot,
  );
}

export async function resolvePtcStateRootRealpath(
  stateRoot: string,
): Promise<string> {
  return await realpath(stateRoot);
}
