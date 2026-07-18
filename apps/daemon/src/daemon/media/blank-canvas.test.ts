import assert from 'node:assert/strict';
import test from 'node:test';

import { blankCanvasDataUrl } from './blank-canvas.js';

void test('blankCanvasDataUrl is a deterministic transparent PNG data url', () => {
  const first = blankCanvasDataUrl();
  assert.equal(first, blankCanvasDataUrl());
  assert.ok(first.startsWith('data:image/png;base64,'));

  const bytes = Buffer.from(
    first.slice('data:image/png;base64,'.length),
    'base64',
  );
  // PNG 시그니처 + IHDR(1280x720, RGBA)
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.equal(bytes.readUInt32BE(16), 1280);
  assert.equal(bytes.readUInt32BE(20), 720);
  assert.equal(bytes[25], 6); // color type RGBA
  // 완전 투명 캔버스는 zlib 압축으로 소형이어야 한다(S0 실측 ~3.6KB)
  assert.ok(bytes.byteLength < 16 * 1024);
});
