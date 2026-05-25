import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_DEV_TOKEN_LENGTH = 16;

export function getConfiguredDevToken(): string {
  const token = process.env['GEULBAT_DEV_TOKEN'];
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('GEULBAT_DEV_TOKEN is required');
  }
  if (token.length < MIN_DEV_TOKEN_LENGTH) {
    throw new Error(
      `GEULBAT_DEV_TOKEN must be at least ${MIN_DEV_TOKEN_LENGTH} characters`,
    );
  }
  return token;
}

export function isValidDevToken(candidate: unknown): boolean {
  if (typeof candidate !== 'string') {
    return false;
  }

  const expected = getConfiguredDevToken();
  const candidateDigest = createHash('sha256')
    .update(candidate, 'utf8')
    .digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}
