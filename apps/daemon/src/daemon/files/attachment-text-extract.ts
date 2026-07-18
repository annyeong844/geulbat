import {
  OfficeTextExtractError,
  extractOfficeText,
  officeTextKindOf,
} from './office-text-extract.js';

// 첨부 본문 추출 추상화 — 업로드된 파일에서 모델이 읽을 텍스트를 뽑는다.
// 새 포맷 지원은 여기 추출기 하나를 등록하는 것으로 끝난다(포맷별 분기를
// 호출부에 두지 않는다). 추출기는 순서대로 시도되고, 자신이 다룰 수 없는
// 입력에는 null을 돌려 다음 추출기로 넘긴다.

type AttachmentTextExtractor = (name: string, bytes: Buffer) => string | null;

function extractOfficeDocumentText(name: string, bytes: Buffer): string | null {
  if (officeTextKindOf(name) === null) {
    return null;
  }
  try {
    return extractOfficeText(name, bytes).text;
  } catch (error: unknown) {
    if (error instanceof OfficeTextExtractError) {
      // 손상/초과 문서는 텍스트 추출 불가로 취급 — 원본 보관 경로로 넘어간다
      return null;
    }
    throw error;
  }
}

function extractUtf8Text(_name: string, bytes: Buffer): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const ATTACHMENT_TEXT_EXTRACTORS: readonly AttachmentTextExtractor[] = [
  extractOfficeDocumentText,
  extractUtf8Text,
];

export function extractAttachmentText(
  name: string,
  bytes: Buffer,
): string | null {
  for (const extractor of ATTACHMENT_TEXT_EXTRACTORS) {
    const text = extractor(name, bytes);
    if (text !== null) {
      return text;
    }
  }
  return null;
}
