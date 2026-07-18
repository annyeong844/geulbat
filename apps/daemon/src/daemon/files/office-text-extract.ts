import { OfficeZipError, openOfficeZip } from './office-zip.js';

// 오피스 문서(zip+XML) 텍스트 추출 — 0단: 서식 없이 본문 텍스트만.
// docx(word), xlsx(excel), hwpx(한글 2014+)를 지원한다. 구형 바이너리
// .hwp는 컨테이너가 zip이 아니라(OLE) 이 경로에서 다루지 않는다.

// zip entry 해제 물리 한도 — zip 폭탄이 daemon 메모리를 소진하지 못하게
// fail-closed로만 작동한다(성공 결과를 자르는 용도가 아님). 큰 문서는
// read_file 페이징이 재진입 경로다.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

interface OfficeTextExtractResult {
  kind: 'docx' | 'xlsx' | 'hwpx';
  text: string;
}

export class OfficeTextExtractError extends Error {
  readonly reason: 'too_large' | 'malformed';

  constructor(message: string, reason: 'too_large' | 'malformed') {
    super(message);
    this.name = 'OfficeTextExtractError';
    this.reason = reason;
  }
}

export function officeTextKindOf(
  fileName: string,
): OfficeTextExtractResult['kind'] | null {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return extension === 'docx' || extension === 'xlsx' || extension === 'hwpx'
    ? extension
    : null;
}

export function extractOfficeText(
  fileName: string,
  bytes: Buffer,
): OfficeTextExtractResult {
  const kind = officeTextKindOf(fileName);
  if (kind === null) {
    throw new OfficeTextExtractError(
      `not an office text container: ${fileName}`,
      'malformed',
    );
  }
  try {
    const zip = openOfficeZip(bytes);
    const text =
      kind === 'docx'
        ? extractDocxText(zip)
        : kind === 'xlsx'
          ? extractXlsxText(zip)
          : extractHwpxText(zip);
    return finalize(kind, text);
  } catch (error: unknown) {
    if (error instanceof OfficeZipError) {
      throw new OfficeTextExtractError(
        `failed to open ${kind} container: ${error.message}`,
        /too large|inflate limit/.test(error.message)
          ? 'too_large'
          : 'malformed',
      );
    }
    throw error;
  }
}

function finalize(
  kind: OfficeTextExtractResult['kind'],
  raw: string,
): OfficeTextExtractResult {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { kind, text: normalized };
}

// ─── docx ───────────────────────────────────────────────────────────

function extractDocxText(zip: ReturnType<typeof openOfficeZip>): string {
  if (!zip.has('word/document.xml')) {
    throw new OfficeTextExtractError(
      'docx is missing word/document.xml',
      'malformed',
    );
  }
  const xml = zip.readText('word/document.xml', MAX_ENTRY_BYTES);
  return extractParagraphXmlText(xml, /<w:p[ >]/, DOCX_RUN_TOKEN_PATTERN);
}

// 텍스트 런과 줄바꿈/탭 요소를 함께 스캔 — <w:br/>, <w:tab/>가 조용히
// 사라지지 않도록 한다
const DOCX_RUN_TOKEN_PATTERN =
  /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:(br|tab)\s*\/>/g;

// ─── hwpx ───────────────────────────────────────────────────────────

function extractHwpxText(zip: ReturnType<typeof openOfficeZip>): string {
  const sections = zip
    .entries()
    .map((entry) => entry.name)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort((a, b) => extractHwpxSectionNumber(a) - extractHwpxSectionNumber(b));
  if (sections.length === 0) {
    throw new OfficeTextExtractError(
      'hwpx is missing Contents/section XML',
      'malformed',
    );
  }
  return sections
    .map((name) =>
      extractParagraphXmlText(
        zip.readText(name, MAX_ENTRY_BYTES),
        /<hp:p[ >]/,
        HWPX_RUN_TOKEN_PATTERN,
      ),
    )
    .join('\n\n');
}

const HWPX_RUN_TOKEN_PATTERN =
  /<hp:t(?: [^>]*)?>([\s\S]*?)<\/hp:t>|<hp:(lineBreak|tab)\s*\/>/g;

function extractHwpxSectionNumber(name: string): number {
  return Number(/section(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

// 단락 태그 경계를 개행으로, 텍스트 런을 이어붙인다
function extractParagraphXmlText(
  xml: string,
  paragraphPattern: RegExp,
  runTokenPattern: RegExp,
): string {
  const paragraphSplit = new RegExp(paragraphPattern.source, 'g');
  const paragraphs = xml.split(paragraphSplit);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const parts: string[] = [];
    for (const match of paragraph.matchAll(runTokenPattern)) {
      if (match[2] !== undefined) {
        parts.push(match[2] === 'tab' ? '\t' : '\n');
      } else {
        parts.push(decodeXmlEntities(match[1] ?? ''));
      }
    }
    if (parts.join('').trim().length > 0) {
      lines.push(parts.join(''));
    }
  }
  return lines.join('\n');
}

// ─── xlsx ───────────────────────────────────────────────────────────

function extractXlsxText(zip: ReturnType<typeof openOfficeZip>): string {
  const sharedStrings = readSharedStrings(zip);
  const sheetNames = readSheetNames(zip);
  const sheets = zip
    .entries()
    .map((entry) => entry.name)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => extractSheetNumber(a) - extractSheetNumber(b));
  if (sheets.length === 0) {
    throw new OfficeTextExtractError(
      'xlsx is missing worksheet XML',
      'malformed',
    );
  }
  const blocks: string[] = [];
  sheets.forEach((name, index) => {
    const xml = zip.readText(name, MAX_ENTRY_BYTES);
    const rows = extractSheetRows(xml, sharedStrings);
    if (rows.length > 0) {
      const label = sheetNames.get(name) ?? `시트 ${index + 1}`;
      blocks.push(`# ${label}\n${rows.join('\n')}`);
    }
  });
  return blocks.join('\n\n');
}

// workbook.xml의 시트 이름을 rels를 거쳐 worksheet 파일에 매핑한다.
// 어느 단계든 실패하면 조용히 빈 매핑(순번 라벨 폴백)으로 남긴다.
function readSheetNames(
  zip: ReturnType<typeof openOfficeZip>,
): Map<string, string> {
  const names = new Map<string, string>();
  if (!zip.has('xl/workbook.xml') || !zip.has('xl/_rels/workbook.xml.rels')) {
    return names;
  }
  const relTargets = new Map<string, string>();
  const relsXml = zip.readText('xl/_rels/workbook.xml.rels', MAX_ENTRY_BYTES);
  for (const rel of relsXml.matchAll(/<Relationship [^>]*\/?>/g)) {
    const id = / Id="([^"]+)"/.exec(rel[0])?.[1];
    const target = / Target="([^"]+)"/.exec(rel[0])?.[1];
    if (id !== undefined && target !== undefined) {
      relTargets.set(id, target.replace(/^\//, '').replace(/^xl\//, ''));
    }
  }
  const workbookXml = zip.readText('xl/workbook.xml', MAX_ENTRY_BYTES);
  for (const sheet of workbookXml.matchAll(/<(?:\w+:)?sheet [^>]*\/?>/g)) {
    const name = / name="([^"]+)"/.exec(sheet[0])?.[1];
    const relId = / r:id="([^"]+)"/.exec(sheet[0])?.[1];
    if (name === undefined || relId === undefined) {
      continue;
    }
    const target = relTargets.get(relId);
    if (target !== undefined) {
      names.set(`xl/${target}`, decodeXmlEntities(name));
    }
  }
  return names;
}

function extractSheetNumber(name: string): number {
  return Number(/sheet(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

// 일부 생성기는 스프레드시트 XML에 네임스페이스 접두사(x: 등)를 붙인다
const XLSX_SI_PATTERN = /<(?:\w+:)?si(?: [^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g;
const XLSX_T_PATTERN = /<(?:\w+:)?t(?: [^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
const XLSX_ROW_PATTERN = /<(?:\w+:)?row(?: [^>]*)?>([\s\S]*?)<\/(?:\w+:)?row>/g;
const XLSX_CELL_PATTERN = /<(?:\w+:)?c(?: ([^>]*))?>([\s\S]*?)<\/(?:\w+:)?c>/g;
const XLSX_VALUE_PATTERN = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/;

function readSharedStrings(zip: ReturnType<typeof openOfficeZip>): string[] {
  if (!zip.has('xl/sharedStrings.xml')) {
    return [];
  }
  const xml = zip.readText('xl/sharedStrings.xml', MAX_ENTRY_BYTES);
  const strings: string[] = [];
  // <si>는 여러 <t> 런으로 쪼개질 수 있다(서식 혼합 셀)
  for (const si of xml.matchAll(XLSX_SI_PATTERN)) {
    const parts: string[] = [];
    for (const t of (si[1] ?? '').matchAll(XLSX_T_PATTERN)) {
      parts.push(decodeXmlEntities(t[1] ?? ''));
    }
    strings.push(parts.join(''));
  }
  return strings;
}

// 행 단위 탭 구분 텍스트 — 표를 그대로 옮기는 목적이 아니라 내용 열람용.
// worksheet XML은 빈 셀을 생략하므로 r 참조(A1, C1…)로 열 위치를 복원한다.
function extractSheetRows(xml: string, sharedStrings: string[]): string[] {
  const rows: string[] = [];
  for (const row of xml.matchAll(XLSX_ROW_PATTERN)) {
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cell of (row[1] ?? '').matchAll(XLSX_CELL_PATTERN)) {
      const attrs = cell[1] ?? '';
      const body = cell[2] ?? '';
      const columnIndex = columnIndexFromCellRef(attrs) ?? nextColumn;
      while (cells.length < columnIndex) {
        cells.push('');
      }
      cells[columnIndex] = readCellText(attrs, body, sharedStrings);
      nextColumn = columnIndex + 1;
    }
    // 전부 빈 셀인 행은 건너뛴다
    if (cells.some((cell) => cell.trim() !== '')) {
      rows.push(cells.join('\t'));
    }
  }
  return rows;
}

function readCellText(
  attrs: string,
  body: string,
  sharedStrings: string[],
): string {
  const isSharedString = / t="s"/.test(` ${attrs}`);
  const isInlineString = / t="inlineStr"/.test(` ${attrs}`);
  if (isInlineString) {
    // 서식 혼합 inline 문자열은 여러 <t> 런으로 쪼개진다 — 전부 이어붙인다
    const parts: string[] = [];
    for (const t of body.matchAll(XLSX_T_PATTERN)) {
      parts.push(decodeXmlEntities(t[1] ?? ''));
    }
    return parts.join('');
  }
  const value = XLSX_VALUE_PATTERN.exec(body)?.[1];
  if (value === undefined) {
    return '';
  }
  if (isSharedString) {
    return sharedStrings[Number(value)] ?? '';
  }
  return decodeXmlEntities(value);
}

// r="C7" → 열 인덱스 2. 참조가 없으면 null(순차 배치로 폴백).
function columnIndexFromCellRef(attrs: string): number | null {
  const ref = / r="([A-Z]+)\d+"/.exec(` ${attrs}`)?.[1];
  if (ref === undefined) {
    return null;
  }
  let index = 0;
  for (const char of ref) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

// ─── 공통 ───────────────────────────────────────────────────────────

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&amp;/g, '&');
}
