import { chmod } from 'node:fs/promises';

export class PtcHostPathModeError extends Error {
  readonly pathKind: string;
  readonly mode: number;

  constructor(args: { pathKind: string; mode: number; cause: unknown }) {
    super(
      `failed to apply private PTC host path mode: ${args.pathKind} ${formatMode(args.mode)}`,
      { cause: args.cause },
    );
    this.name = 'PtcHostPathModeError';
    this.pathKind = args.pathKind;
    this.mode = args.mode;
  }
}

export async function applyPtcHostPathMode(args: {
  path: string;
  pathKind: string;
  mode: number;
}): Promise<void> {
  try {
    await chmod(args.path, args.mode);
  } catch (cause: unknown) {
    throw new PtcHostPathModeError({
      pathKind: args.pathKind,
      mode: args.mode,
      cause,
    });
  }
}

export function ptcHostPathModeDiagnostics(
  error: unknown,
): Record<string, string | number | boolean> {
  if (error instanceof PtcHostPathModeError) {
    return {
      hostPathModeFailed: true,
      pathKind: error.pathKind,
      mode: formatMode(error.mode),
    };
  }
  return { hostPathPrepareFailed: true };
}

function formatMode(mode: number): string {
  return `0o${mode.toString(8)}`;
}
