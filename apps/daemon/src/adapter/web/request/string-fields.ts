interface ValidatedStringField {
  ok: true;
  value: string;
}

interface InvalidStringField {
  ok: false;
  message: string;
}

type ValidatedField = ValidatedStringField | InvalidStringField;

export function readRequiredQueryString(
  value: unknown,
  name: string,
): ValidatedField {
  if (Array.isArray(value)) {
    return { ok: false, message: `${name} must be a single string` };
  }
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, message: `${name} is required` };
  }
  return { ok: true, value };
}

export function readRequiredBodyString(
  body: Record<string, unknown> | undefined,
  name: string,
): ValidatedField {
  const value = body?.[name];
  if (typeof value !== 'string') {
    return { ok: false, message: `${name} must be a string` };
  }
  if (value.length === 0) {
    return { ok: false, message: `${name} is required` };
  }
  return { ok: true, value };
}

export function readBodyString(
  body: Record<string, unknown> | undefined,
  name: string,
): ValidatedField {
  const value = body?.[name];
  if (typeof value !== 'string') {
    return { ok: false, message: `${name} must be a string` };
  }
  return { ok: true, value };
}

export function readRequiredBodyStrings<const T extends string>(
  body: Record<string, unknown> | undefined,
  names: readonly T[],
): { ok: true; read(name: T): string } | InvalidStringField {
  const values = new Map<T, string>();
  for (const name of names) {
    const result = readRequiredBodyString(body, name);
    if (!result.ok) {
      return result;
    }
    values.set(name, result.value);
  }
  return {
    ok: true,
    read(name) {
      const value = values.get(name);
      if (value === undefined) {
        throw new Error(`required body string was not validated: ${name}`);
      }
      return value;
    },
  };
}
