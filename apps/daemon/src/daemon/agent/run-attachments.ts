// run 시작 시 resolve된 사용자 첨부 — 어댑터(ws)와 agent 계층이 공유하는
// 좁은 계약. 인라인 첨부는 바이트를 직접 들고 모델 입력 블록으로 나가고,
// 인라인 한도를 넘는 내용은 앞부분 인라인 + 전체본 사본으로 소화된다.
export interface ResolvedRunAttachment {
  name: string;
  mimeType: string;
  kind: 'image' | 'text' | 'pdf';
  bytes: Buffer;
}

// 상한은 환경변수로 조정 가능 — 기본값은 공웹 수준.
function readPositiveIntKnob(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// 업로드 상한 — 파일당 512MB, 메시지당 20개.
export const RUN_ATTACHMENT_MAX_COUNT = readPositiveIntKnob(
  'GEULBAT_ATTACHMENT_MAX_COUNT',
  20,
);
export const RUN_ATTACHMENT_MAX_BYTES = readPositiveIntKnob(
  'GEULBAT_ATTACHMENT_MAX_BYTES',
  512 * 1024 * 1024,
);

// 모델 입력으로 통째로 인라인하는 한도. 이미지/PDF는 프로바이더 요청 한도,
// 텍스트는 모델 컨텍스트가 물리 제약이다. 한도를 넘는 텍스트는 앞부분을
// 인라인하고 전체 추출본을 작업 폴더 사본으로 남겨 어시스턴트가 도구로
// 이어 읽는다(사용자에게 읽으라고 안내하는 용도가 아니다).
export const RUN_ATTACHMENT_IMAGE_INLINE_MAX_BYTES = readPositiveIntKnob(
  'GEULBAT_ATTACHMENT_IMAGE_INLINE_MAX_BYTES',
  20 * 1024 * 1024,
);
export const RUN_ATTACHMENT_PDF_INLINE_MAX_BYTES = readPositiveIntKnob(
  'GEULBAT_ATTACHMENT_PDF_INLINE_MAX_BYTES',
  30 * 1024 * 1024,
);
export const RUN_ATTACHMENT_TEXT_INLINE_MAX_CHARS = readPositiveIntKnob(
  'GEULBAT_ATTACHMENT_TEXT_INLINE_MAX_CHARS',
  200 * 1024,
);

// 본문 추출을 위해 파일 전체를 메모리에 올리는 크기 상한 — 업로드 상한과는
// 별개다. 이보다 큰 파일은 읽지 않고 원본을 작업 폴더로 옮겨(rename, 메모리
// 0) 어시스턴트가 도구로 나눠 읽는다. 512MB 업로드는 그대로 허용된다.
export const RUN_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES = readPositiveIntKnob(
  'GEULBAT_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES',
  64 * 1024 * 1024,
);

// 인라인을 넘긴 첨부의 원본/전체 추출본이 보관되는 작업 폴더 하위 경로
export const RUN_ATTACHMENT_WORKSPACE_DIR = '첨부';
