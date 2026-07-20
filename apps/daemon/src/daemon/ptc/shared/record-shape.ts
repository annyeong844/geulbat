export function isPtcRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type DefinedPtcProps<T extends Record<string, unknown>> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
} & {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

export function definedPtcProps<T extends Record<string, unknown>>(
  props: T,
): DefinedPtcProps<T> {
  const result: Partial<Record<keyof T, unknown>> = {};
  for (const key of Object.keys(props) as Array<keyof T>) {
    const value = props[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as unknown as DefinedPtcProps<T>;
}
