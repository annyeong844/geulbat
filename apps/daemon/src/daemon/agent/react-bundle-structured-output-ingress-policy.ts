export interface ReactBundleStructuredOutputIngressPolicy {
  timeoutMs: number;
}

export const REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV =
  'GEULBAT_REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS' as const;

// Node timers overflow above signed 32-bit milliseconds and clamp to 1ms.
export const REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MAX_MS = 2_147_483_647;

const DEFAULT_REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS = 30_000;

type ReactBundleStructuredOutputIngressPolicyEnv = Partial<
  Record<typeof REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV, string>
>;

export function resolveReactBundleStructuredOutputIngressPolicyFromEnv(
  env: ReactBundleStructuredOutputIngressPolicyEnv = process.env,
): ReactBundleStructuredOutputIngressPolicy {
  return {
    timeoutMs: readPositiveIntegerEnv(
      env,
      REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV,
      DEFAULT_REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS,
    ),
  };
}

function readPositiveIntegerEnv(
  env: ReactBundleStructuredOutputIngressPolicyEnv,
  name: keyof ReactBundleStructuredOutputIngressPolicyEnv,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (!value) {
    throw new Error(`invalid ${name}: empty`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }
  if (parsed > REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MAX_MS) {
    throw new Error(`invalid ${name}: exceeds Node.js timer maximum`);
  }
  return parsed;
}
