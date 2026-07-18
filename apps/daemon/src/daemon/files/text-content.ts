const BINARY_SNIFF_LENGTH_BYTES = 8192;

export function normalizeTextContent(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function splitTextLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function countTextLines(text: string): number {
  if (text === '') {
    return 0;
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    return lines.length - 1;
  }
  return lines.length;
}

export function decodeTextBuffer(buf: Buffer): string {
  return normalizeTextContent(buf.toString('utf8'));
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const checkLength = Math.min(buf.length, BINARY_SNIFF_LENGTH_BYTES);
  for (let i = 0; i < checkLength; i += 1) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}
