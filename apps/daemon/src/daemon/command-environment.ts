export function buildAllowlistedCommandEnv(
  keys: readonly string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: sourceEnv.PATH ?? '',
    ...Object.fromEntries(
      keys.flatMap((key) => {
        const value = sourceEnv[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}
