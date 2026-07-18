interface SandboxEnvironmentOptions {
  homeDir: string;
  tempDir: string;
  adapterEnv?: Readonly<Record<string, string>>;
}

export function buildSandboxEnvironment(
  options: SandboxEnvironmentOptions,
): NodeJS.ProcessEnv {
  return {
    HOME: options.homeDir,
    TMPDIR: options.tempDir,
    TEMP: options.tempDir,
    TMP: options.tempDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    ...(options.adapterEnv ?? {}),
  };
}
