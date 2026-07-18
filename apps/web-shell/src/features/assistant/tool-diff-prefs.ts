// diff 기본 펼침 설정 — [+] 메뉴의 "diff 항상 펼치기" 토글이 소유한다.
// 온: 파일 변경 diff가 펼쳐진 채로 렌더(숙련 사용자), 오프: 접힌 헤더만
// 먼저(기본). localStorage에 남고, 구독 중인 블록들은 즉시 따라간다.

const TOOL_DIFF_EXPANDED_PREF_KEY = 'geulbat.toolDiffExpandedDefault';

let cachedDefault: boolean | null = null;
const listeners = new Set<() => void>();

function readStoredDefault(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(TOOL_DIFF_EXPANDED_PREF_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function getToolDiffExpandedDefault(): boolean {
  if (cachedDefault === null) {
    cachedDefault = readStoredDefault();
  }
  return cachedDefault;
}

export function setToolDiffExpandedDefault(value: boolean): void {
  cachedDefault = value;
  try {
    globalThis.localStorage?.setItem(
      TOOL_DIFF_EXPANDED_PREF_KEY,
      value ? '1' : '0',
    );
  } catch {
    // 저장 불가 환경에서는 세션 내 동작만 유지
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToolDiffExpandedDefault(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// SSR/정적 렌더 스냅샷 — 접힘 기본
export function getToolDiffExpandedDefaultServerSnapshot(): boolean {
  return false;
}
