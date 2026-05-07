import { createHash } from 'node:crypto';

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
