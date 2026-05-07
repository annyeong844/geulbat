export function replaceTemplateTokens(
  source: string,
  replacements: Record<string, string>,
): string {
  return Object.entries(replacements).reduce(
    (nextSource, [token, value]) => nextSource.replaceAll(token, value),
    source,
  );
}
