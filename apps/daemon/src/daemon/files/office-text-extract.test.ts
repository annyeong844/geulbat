import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  extractOfficeText,
  officeTextKindOf,
  OfficeTextExtractError,
} from './office-text-extract.js';
import { openOfficeZip } from './office-zip.js';

// 테스트 전용 zip 조립기 — stored/deflate 로컬 헤더 + central directory + EOCD
function buildZip(
  files: Array<{ name: string; content: string }>,
  options: { store?: boolean } = {},
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const data = options.store ? raw : deflateRawSync(raw);
    const method = options.store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 12);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, data);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

void test('officeTextKindOf detects supported extensions only', () => {
  assert.equal(officeTextKindOf('보고서.docx'), 'docx');
  assert.equal(officeTextKindOf('표.XLSX'.toLowerCase()), 'xlsx');
  assert.equal(officeTextKindOf('원고.hwpx'), 'hwpx');
  assert.equal(officeTextKindOf('원고.hwp'), null);
  assert.equal(officeTextKindOf('메모.md'), null);
});

void test('extracts docx paragraphs with runs and entities', () => {
  const zip = buildZip([
    {
      name: 'word/document.xml',
      content:
        '<w:document><w:body>' +
        '<w:p><w:r><w:t>첫 번째 </w:t></w:r><w:r><w:t>단락</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>둘째 &amp; 셋째 &lt;표시&gt;</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    },
  ]);
  const result = extractOfficeText('문서.docx', zip);
  assert.equal(result.kind, 'docx');
  assert.equal(result.text, '첫 번째 단락\n둘째 & 셋째 <표시>');
});

void test('extracts hwpx sections in order', () => {
  const zip = buildZip([
    {
      name: 'Contents/section0.xml',
      content:
        '<hs:sec><hp:p><hp:run><hp:t>새벽이 오기 전</hp:t></hp:run></hp:p></hs:sec>',
    },
    {
      name: 'Contents/section1.xml',
      content:
        '<hs:sec><hp:p><hp:run><hp:t>노트의 빈 페이지</hp:t></hp:run></hp:p></hs:sec>',
    },
  ]);
  const result = extractOfficeText('원고.hwpx', zip);
  assert.equal(result.kind, 'hwpx');
  assert.equal(result.text, '새벽이 오기 전\n\n노트의 빈 페이지');
});

void test('extracts xlsx shared strings, inline strings, and numbers', () => {
  const zip = buildZip([
    {
      name: 'xl/sharedStrings.xml',
      content: '<sst><si><t>이름</t></si><si><t>메</t><t>모</t></si></sst>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>수연</t></is></c><c r="B2"><v>42</v></c></row>' +
        '<row r="3"><c r="A3"></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
  const result = extractOfficeText('표.xlsx', zip);
  assert.equal(result.kind, 'xlsx');
  assert.equal(result.text, '# 시트 1\n이름\t메모\n수연\t42');
});

void test('stored (uncompressed) zip entries are readable', () => {
  const zip = buildZip(
    [
      {
        name: 'word/document.xml',
        content: '<w:p><w:t>무압축</w:t></w:p>',
      },
    ],
    { store: true },
  );
  assert.equal(extractOfficeText('문서.docx', zip).text, '무압축');
});

void test('rejects non-zip bytes with a clear error', () => {
  assert.throws(
    () => extractOfficeText('문서.docx', Buffer.from('plain text')),
    OfficeTextExtractError,
  );
});

void test('rejects docx without document.xml', () => {
  const zip = buildZip([{ name: 'other.xml', content: '<x/>' }]);
  assert.throws(
    () => extractOfficeText('문서.docx', zip),
    OfficeTextExtractError,
  );
});

void test('zip reader lists entries', () => {
  const zip = openOfficeZip(
    buildZip([
      { name: 'a.xml', content: 'aaa' },
      { name: 'b/c.xml', content: 'ccc' },
    ]),
  );
  assert.deepEqual(
    zip.entries().map((entry) => entry.name),
    ['a.xml', 'b/c.xml'],
  );
  assert.equal(zip.readText('b/c.xml', 1024), 'ccc');
});

void test('sorts hwpx sections numerically (section10 after section2)', () => {
  const zip = buildZip([
    {
      name: 'Contents/section10.xml',
      content: '<hp:p><hp:run><hp:t>열 번째</hp:t></hp:run></hp:p>',
    },
    {
      name: 'Contents/section2.xml',
      content: '<hp:p><hp:run><hp:t>두 번째</hp:t></hp:run></hp:p>',
    },
    {
      name: 'Contents/section0.xml',
      content: '<hp:p><hp:run><hp:t>첫 번째</hp:t></hp:run></hp:p>',
    },
  ]);
  assert.equal(
    extractOfficeText('원고.hwpx', zip).text,
    '첫 번째\n\n두 번째\n\n열 번째',
  );
});

void test('preserves docx line breaks and tabs between runs', () => {
  const zip = buildZip([
    {
      name: 'word/document.xml',
      content:
        '<w:p><w:r><w:t>앞</w:t></w:r><w:r><w:br/></w:r>' +
        '<w:r><w:t>뒤</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>끝</w:t></w:r></w:p>',
    },
  ]);
  assert.equal(extractOfficeText('문서.docx', zip).text, '앞\n뒤\t끝');
});

void test('concatenates all inline string runs in a cell', () => {
  const zip = buildZip([
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData><row r="1">' +
        '<c r="A1" t="inlineStr"><is><r><t>메</t></r><r><t>모</t></r></is></c>' +
        '</row></sheetData></worksheet>',
    },
  ]);
  assert.equal(extractOfficeText('표.xlsx', zip).text, '# 시트 1\n메모');
});

void test('restores sparse xlsx columns from cell references', () => {
  const zip = buildZip([
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData><row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>가</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>다</t></is></c>' +
        '</row></sheetData></worksheet>',
    },
  ]);
  // B열이 생략돼도 다는 C열 자리에 남아야 한다
  assert.equal(extractOfficeText('표.xlsx', zip).text, '# 시트 1\n가\t\t다');
});

void test('rejects zip-bomb style entries that lie about uncompressed size', () => {
  // 실제로는 128MB로 부풀지만 central directory에는 32바이트로 신고
  const hugeXml = '<w:p><w:t>' + '가'.repeat(40 * 1024 * 1024) + '</w:t></w:p>';
  const zip = buildZip([{ name: 'word/document.xml', content: hugeXml }]);
  // uncompressedSize 필드를 거짓으로 축소 조작
  const eocdOffset = zip.length - 22;
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  zip.writeUInt32LE(32, centralOffset + 24);
  assert.throws(
    () => extractOfficeText('문서.docx', zip),
    (error: unknown) =>
      error instanceof OfficeTextExtractError && error.reason === 'too_large',
  );
});

void test('uses real sheet names from workbook when available', () => {
  const zip = buildZip([
    {
      name: 'xl/workbook.xml',
      content:
        '<workbook><sheets>' +
        '<sheet name="장소 목록" sheetId="1" r:id="rId1"/>' +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<Relationships>' +
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData><row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>앞산</t></is></c>' +
        '</row></sheetData></worksheet>',
    },
  ]);
  assert.equal(extractOfficeText('표.xlsx', zip).text, '# 장소 목록\n앞산');
});
