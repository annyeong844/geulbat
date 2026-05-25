const MIN_PORT = 1;
const MAX_PORT = 65_535;

export const DEFAULT_DAEMON_PORT = 3456;

export function readDaemonPort(value?: string): number {
  if (value === undefined) {
    return DEFAULT_DAEMON_PORT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(`invalid PORT: ${value}`);
  }

  return parsed;
}
