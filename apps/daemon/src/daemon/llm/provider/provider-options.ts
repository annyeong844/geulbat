type ProviderReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
type ProviderTextVerbosity = 'low' | 'medium' | 'high';

interface ProviderRequestOptions {
  model: string;
  text: { verbosity: ProviderTextVerbosity };
  reasoning: { effort: ProviderReasoningEffort; summary: 'auto' };
}

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_REASONING_EFFORT: ProviderReasoningEffort = 'medium';
const DEFAULT_TEXT_VERBOSITY: ProviderTextVerbosity = 'medium';

const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const TEXT_VERBOSITIES = ['low', 'medium', 'high'] as const;

type ProviderEnv = Partial<
  Record<
    | 'GEULBAT_CODEX_MODEL'
    | 'GEULBAT_CODEX_REASONING_EFFORT'
    | 'GEULBAT_CODEX_TEXT_VERBOSITY',
    string
  >
>;

function readEnvValue(
  env: ProviderEnv,
  name: keyof ProviderEnv,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    throw new Error(`invalid ${name}: empty`);
  }
  return value;
}

function readEnumValue<TValue extends string>(
  env: ProviderEnv,
  name: keyof ProviderEnv,
  values: readonly TValue[],
  fallback: TValue,
): TValue {
  const value = readEnvValue(env, name);
  if (value === undefined) {
    return fallback;
  }
  if (values.includes(value as TValue)) {
    return value as TValue;
  }
  throw new Error(`invalid ${name}: ${value}`);
}

export function resolveProviderRequestOptions(
  env: ProviderEnv = process.env,
): ProviderRequestOptions {
  return {
    model: readEnvValue(env, 'GEULBAT_CODEX_MODEL') ?? DEFAULT_CODEX_MODEL,
    text: {
      verbosity: readEnumValue(
        env,
        'GEULBAT_CODEX_TEXT_VERBOSITY',
        TEXT_VERBOSITIES,
        DEFAULT_TEXT_VERBOSITY,
      ),
    },
    reasoning: {
      effort: readEnumValue(
        env,
        'GEULBAT_CODEX_REASONING_EFFORT',
        REASONING_EFFORTS,
        DEFAULT_REASONING_EFFORT,
      ),
      summary: 'auto',
    },
  };
}
