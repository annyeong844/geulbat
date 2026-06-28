import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Create a versionToken from canonical UTF-8 content.
 * Same content always produces the same token (SHA-256 content digest).
 */
export function createVersionToken(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function createBinaryVersionToken(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function createBinaryVersionTokenFromFile(
  path: string,
): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}
