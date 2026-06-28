import { basename, extname } from 'node:path';

import type { MemoryChunkRecord } from './types.js';
import type { SourceFileData } from './source-snapshot.js';

const CHUNK_TARGET_LINES = 80;
const EXCERPT_LIMIT = 160;

export function createChunkRecords(
  sourceFile: SourceFileData,
): MemoryChunkRecord[] {
  if (sourceFile.lines.length === 0) {
    return [];
  }

  const records: MemoryChunkRecord[] = [];
  const title = deriveTitle(sourceFile.path, sourceFile.lines);

  for (
    let lineStartIndex = 0;
    lineStartIndex < sourceFile.lines.length;
    lineStartIndex += CHUNK_TARGET_LINES
  ) {
    const chunkLines = sourceFile.lines.slice(
      lineStartIndex,
      lineStartIndex + CHUNK_TARGET_LINES,
    );
    const searchText = chunkLines.join('\n');
    const lineStart = lineStartIndex + 1;
    const lineEnd = lineStartIndex + chunkLines.length;
    const chunkNumber = String(records.length + 1).padStart(4, '0');

    records.push({
      chunkId: `${sourceFile.path}#${chunkNumber}`,
      path: sourceFile.path,
      sourceVersionToken: sourceFile.sourceVersionToken,
      title,
      lineStart,
      lineEnd,
      excerpt: searchText.slice(0, EXCERPT_LIMIT),
      searchText,
    });
  }

  return records;
}

function deriveTitle(relativePath: string, lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s+/, '');
  }
  const fileName = basename(relativePath);
  const ext = extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}
