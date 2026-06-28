export const MID_RUN_STEER_ENABLED_ENV = 'GEULBAT_MID_RUN_STEER';

export function isMidRunSteerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MID_RUN_STEER_ENABLED_ENV] === '1';
}
