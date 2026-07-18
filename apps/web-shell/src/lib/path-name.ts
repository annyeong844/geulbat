// workspace 상대 경로 문자열 분해 — 트리/에디터/버퍼가 공유하는 단일 owner

export function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

export function parentDirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function splitExtension(name: string): { base: string; ext: string } {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) {
    return { base: name, ext: '' };
  }
  return { base: name.slice(0, dotIndex), ext: name.slice(dotIndex) };
}
