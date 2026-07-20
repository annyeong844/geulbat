export function toKebabFileStem(value: string): string {
  return tokenizeIdentifier(value).join('-');
}

export function toIdentifier(value: string, fallback: string): string {
  const tokens = tokenizeIdentifier(value);
  if (tokens.length === 0) {
    return fallback;
  }
  const candidate = [tokens[0], ...tokens.slice(1).map(capitalizeAscii)].join(
    '',
  );
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(candidate) ? candidate : fallback;
}

export function toPascalCase(value: string): string {
  const tokens = tokenizeIdentifier(value);
  if (tokens.length === 0) {
    return 'Tool';
  }
  return tokens.map(capitalizeAscii).join('');
}

function tokenizeIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

function capitalizeAscii(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
