// 중앙 편집기 보기 모드: 리치 에디터(prose) / 코드 뷰어(mono).
// 코드 확장자 파일은 자동으로 코드 뷰어가 된다. raw 모드는 코드 뷰어와
// 동일한 표현이라 별도로 두지 않는다.
export type ManuscriptViewMode = 'rich' | 'code';

const CODE_FILE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'css',
  'scss',
  'html',
  'xml',
  'svg',
  'yaml',
  'yml',
  'toml',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'h',
  'cpp',
  'sh',
  'sql',
]);

export function isCodeFileName(name: string): boolean {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  return CODE_FILE_EXTENSIONS.has(name.slice(dotIndex + 1).toLowerCase());
}

export function formatSaveStateLabel(args: {
  saving: boolean;
  isDirty: boolean;
  saveFailed: boolean;
  lastSavedAt: number | null;
  now?: number;
}): string {
  const { saving, isDirty, saveFailed, lastSavedAt } = args;
  const now = args.now ?? Date.now();
  if (saveFailed) {
    return '저장 실패';
  }
  if (saving) {
    return '저장 중...';
  }
  if (isDirty) {
    return '저장되지 않은 변경';
  }
  if (lastSavedAt === null) {
    return '';
  }
  const minutes = Math.floor((now - lastSavedAt) / 60_000);
  if (minutes < 1) {
    return '방금 저장됨';
  }
  return `${minutes}분 전 저장됨`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export function splitBreadcrumb(path: string): string[] {
  return path.split('/').filter(Boolean);
}
