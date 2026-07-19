export const PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME =
  'GEULBAT_PUBLIC_WEB_CONFORMANCE_FIXTURES';

const PUBLIC_WEB_CONFORMANCE_FIXTURES_ENABLED_VALUE = '1';

export function readPublicWebConformanceFixturesEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const configured = environment[PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME];
  if (configured === undefined) {
    return false;
  }
  if (configured === PUBLIC_WEB_CONFORMANCE_FIXTURES_ENABLED_VALUE) {
    return true;
  }
  throw new Error(
    `${PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME} must be unset or "${PUBLIC_WEB_CONFORMANCE_FIXTURES_ENABLED_VALUE}"`,
  );
}
