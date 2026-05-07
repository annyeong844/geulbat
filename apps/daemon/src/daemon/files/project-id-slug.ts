import type { ProjectId } from '@geulbat/protocol/ids';

export function deriveProjectId(
  label: string,
  existingIds: ReadonlySet<string>,
): ProjectId {
  const base = normalizeProjectSlug(label);
  let candidate = base;
  let suffix = 2;

  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate as ProjectId;
}

function normalizeProjectSlug(label: string): string {
  const slug = label
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return slug || 'project';
}
