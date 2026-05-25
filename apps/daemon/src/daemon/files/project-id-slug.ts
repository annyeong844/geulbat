import { assertProjectId, type ProjectId } from '@geulbat/protocol/ids';

const PROJECT_ID_MAX_LENGTH = 128;
const DEFAULT_PROJECT_ID_BASE = 'project';

export function deriveProjectId(
  label: string,
  existingIds: ReadonlySet<string>,
): ProjectId {
  const base = normalizeProjectSlug(label);
  let suffix: number | null = null;

  while (true) {
    const candidate = buildProjectIdCandidate(base, suffix);
    if (!existingIds.has(candidate)) {
      return assertProjectId(candidate);
    }
    suffix = suffix === null ? 2 : suffix + 1;
  }
}

function normalizeProjectSlug(label: string): string {
  const slug = label
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return slug || DEFAULT_PROJECT_ID_BASE;
}

function buildProjectIdCandidate(base: string, suffix: number | null): string {
  const suffixText = suffix === null ? '' : `-${suffix}`;
  // Keep aligned with the protocol guard; assertProjectId below catches drift.
  const baseLength = PROJECT_ID_MAX_LENGTH - suffixText.length;
  const candidateBase =
    Array.from(base).slice(0, baseLength).join('').replace(/-+$/g, '') ||
    DEFAULT_PROJECT_ID_BASE;
  return `${candidateBase}${suffixText}`;
}
