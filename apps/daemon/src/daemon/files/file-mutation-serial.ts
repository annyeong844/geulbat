import { createKeyedSerialRunner } from '../utils/keyed-serial.js';

const runSerializedByCanonicalPath = createKeyedSerialRunner();

export async function runSourceMutationSerial<T>(
  canonicalAbsolutePaths: string | readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = Array.isArray(canonicalAbsolutePaths)
    ? canonicalAbsolutePaths
    : [canonicalAbsolutePaths];
  const uniqueSortedKeys = [...new Set(keys)].sort();

  function runAt(index: number): Promise<T> {
    const key = uniqueSortedKeys[index];
    if (key === undefined) {
      return operation();
    }
    return runSerializedByCanonicalPath(key, () => runAt(index + 1));
  }

  return runAt(0);
}
