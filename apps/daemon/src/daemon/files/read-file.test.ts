import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAccessError } from './file-domain-error.js';
import { readFile, readFilePage } from './read-file.js';
import { PathEscapeError } from './normalize-path.js';
import type { FileStateCache } from '../utils/file-state-cache.js';

void test('readFile blocks reserved .env files', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));
  await writeFile(join(workspaceRoot, '.env'), 'SECRET=1\n', 'utf8');

  await assert.rejects(
    () => readFile(workspaceRoot, '.env'),
    (error: unknown) =>
      error instanceof FileAccessError && error.code === 'access_denied',
  );
});

void test('readFile blocks workspace escape paths', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(join(workspaceRoot, 'docs', 'sample.md'), '# ok\n', 'utf8');

  await assert.rejects(
    () => readFile(workspaceRoot, '../../etc/passwd'),
    (error: unknown) => error instanceof PathEscapeError,
  );
});

void test('readFile rejects Windows-form absolute paths outside the workspace drive', async () => {
  await assert.rejects(
    () => readFile('C:\\workspace', 'D:\\secrets\\file.txt'),
    (error: unknown) => error instanceof PathEscapeError,
  );
});

void test('readFile returns canonical full-file metadata', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'line 1\nline 2\n', 'utf8');

  const result = await readFile(workspaceRoot, 'hello.txt');

  assert.equal(result.path, 'hello.txt');
  assert.equal(result.totalLines, 2);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 2);
});

void test('readFilePage streams explicit line pages with full-file version tokens', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-page-'));
  await writeFile(
    join(workspaceRoot, 'hello.txt'),
    '\uFEFFa\r\nb\r\nc',
    'utf8',
  );

  const full = await readFile(workspaceRoot, 'hello.txt');
  const page = await readFilePage(workspaceRoot, 'hello.txt', {
    offset: 1,
    limit: 1,
  });

  assert.equal(full.content, 'a\nb\nc');
  assert.equal(page.content, 'b\n');
  assert.equal(page.versionToken, full.versionToken);
  assert.equal(page.totalLines, 3);
  assert.equal(page.startLine, 2);
  assert.equal(page.endLine, 2);
});

void test('readFilePage rejects binary files before returning a page', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-page-'));
  await writeFile(join(workspaceRoot, 'binary.dat'), Buffer.from([0, 1, 2, 3]));

  await assert.rejects(
    () => readFilePage(workspaceRoot, 'binary.dat', { offset: 0, limit: 1 }),
    (error: unknown) =>
      error instanceof FileAccessError && error.code === 'binary_file',
  );
});

void test('readFile reads large text files without a hidden byte cap', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-large-'));
  const content = `${'x'.repeat(1024 * 1024 + 64)}\n`;
  await writeFile(join(workspaceRoot, 'large.txt'), content, 'utf8');

  const result = await readFile(workspaceRoot, 'large.txt');

  assert.equal(result.path, 'large.txt');
  assert.equal(result.content, content);
  assert.equal(result.totalLines, 1);
});

void test('readFile delegates resolved source reads to the injected file state cache', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-cache-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'cached\n', 'utf8');
  let loadCount = 0;
  let cachedContent: string | null = null;
  let observedPath: string | null = null;

  const fileStateCache: FileStateCache = {
    async read(path, loadContent) {
      observedPath = path;
      if (cachedContent === null) {
        loadCount += 1;
        cachedContent = await loadContent(path);
      }
      return cachedContent;
    },
    async invalidatePath() {},
    invalidateCacheKey() {},
    clear() {},
    getStats() {
      return {
        entryCount: cachedContent === null ? 0 : 1,
        totalBytes:
          cachedContent === null ? 0 : Buffer.byteLength(cachedContent),
        maxEntries: 100,
        maxTotalBytes: 25 * 1024 * 1024,
      };
    },
  };

  const first = await readFile(workspaceRoot, 'hello.txt', { fileStateCache });
  await writeFile(absolutePath, 'changed\n', 'utf8');
  const second = await readFile(workspaceRoot, 'hello.txt', { fileStateCache });

  assert.equal(observedPath, absolutePath);
  assert.equal(loadCount, 1);
  assert.equal(first.content, 'cached\n');
  assert.equal(second.content, 'cached\n');
});

void test('readFile not_found errors include the normalized path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));

  await assert.rejects(
    () => readFile(workspaceRoot, 'missing.txt'),
    (error: unknown) => {
      const candidate = error as { code?: string; path?: string };
      assert.equal(candidate.code, 'not_found');
      assert.equal(candidate.path, 'missing.txt');
      return true;
    },
  );
});

// ─── 오피스 추출 read 통합 ───────────────────────────────────────────

import { deflateRawSync } from 'node:zlib';
import { readFilePage as readFilePageForOffice } from './read-file.js';

function buildOfficeFixtureZip(
  files: Array<{ name: string; content: string }>,
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBytes, data);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

void test('readFile returns extracted office text flagged as extractedDocument', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-office-'));
  const paragraphs = ['하나', '둘', '셋']
    .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
    .join('');
  await writeFile(
    join(workspaceRoot, '문서.docx'),
    buildOfficeFixtureZip([
      { name: 'word/document.xml', content: `<w:body>${paragraphs}</w:body>` },
    ]),
  );
  const result = await readFile(workspaceRoot, '문서.docx');
  assert.equal(result.extractedDocument, 'docx');
  assert.equal(result.content, '하나\n둘\n셋');
  assert.equal(result.totalLines, 3);
});

void test('readFilePage pages extracted office text by line coordinates', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-office-'));
  const paragraphs = Array.from({ length: 5 }, (_, i) => i + 1)
    .map((n) => `<w:p><w:r><w:t>줄${n}</w:t></w:r></w:p>`)
    .join('');
  await writeFile(
    join(workspaceRoot, '문서.docx'),
    buildOfficeFixtureZip([
      { name: 'word/document.xml', content: `<w:body>${paragraphs}</w:body>` },
    ]),
  );
  const page = await readFilePageForOffice(workspaceRoot, '문서.docx', {
    offset: 2,
    limit: 2,
  });
  assert.equal(page.content, '줄3\n줄4');
  assert.equal(page.startLine, 3);
  assert.equal(page.endLine, 4);
  assert.equal(page.totalLines, 5);
  assert.equal(page.extractedDocument, 'docx');
});

void test('missing office file surfaces as not_found', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-office-'));
  await assert.rejects(
    readFile(workspaceRoot, '없는문서.docx'),
    (error: unknown) =>
      error instanceof Error && /not found/i.test(error.message),
  );
});
