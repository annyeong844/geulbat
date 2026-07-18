import { inflateRawSync } from 'node:zlib';

// 오피스 컨테이너(zip) 최소 리더 — 의존성 없이 내장 zlib만 쓴다.
// docx/xlsx/hwpx가 쓰는 stored(0)/deflate(8) 압축만 지원하며,
// 텍스트 추출 용도라 그 외 방식은 명시적으로 거부한다.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export class OfficeZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeZipError';
  }
}

interface OfficeZipReader {
  entries(): ZipEntry[];
  readText(name: string, maxBytes: number): string;
  has(name: string): boolean;
}

interface ParsedEntry extends ZipEntry {
  localHeaderOffset: number;
  compressionMethod: number;
}

export function openOfficeZip(buffer: Buffer): OfficeZipReader {
  const entries = parseCentralDirectory(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  return {
    entries() {
      return entries.map(({ name, compressedSize, uncompressedSize }) => ({
        name,
        compressedSize,
        uncompressedSize,
      }));
    },
    has(name) {
      return byName.has(name);
    },
    readText(name, maxBytes) {
      const entry = byName.get(name);
      if (entry === undefined) {
        throw new OfficeZipError(`zip entry not found: ${name}`);
      }
      if (entry.uncompressedSize > maxBytes) {
        throw new OfficeZipError(
          `zip entry too large: ${name} (${entry.uncompressedSize} bytes)`,
        );
      }
      return readEntryBytes(buffer, entry, maxBytes).toString('utf8');
    },
  };
}

function parseCentralDirectory(buffer: Buffer): ParsedEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries: ParsedEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (
      cursor + 46 > buffer.length ||
      buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new OfficeZipError('malformed zip central directory');
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD는 파일 끝에서 역방향 탐색 (주석 최대 64KB)
  const scanStart = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= scanStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new OfficeZipError('not a zip container (missing end of directory)');
}

function readEntryBytes(
  buffer: Buffer,
  entry: ParsedEntry,
  maxBytes: number,
): Buffer {
  const offset = entry.localHeaderOffset;
  if (
    offset + 30 > buffer.length ||
    buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw new OfficeZipError(`malformed zip local header: ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return Buffer.from(data);
  }
  if (entry.compressionMethod === 8) {
    // central directory의 uncompressedSize는 신뢰할 수 없다(조작 가능) —
    // 해제 단계 자체를 상한으로 묶어 zip 폭탄이 메모리를 소진하지 못하게
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch {
      throw new OfficeZipError(
        `zip entry exceeded inflate limit or is corrupt: ${entry.name}`,
      );
    }
    if (inflated.byteLength > maxBytes) {
      throw new OfficeZipError(`zip entry too large: ${entry.name}`);
    }
    return inflated;
  }
  throw new OfficeZipError(
    `unsupported zip compression method ${entry.compressionMethod}: ${entry.name}`,
  );
}
