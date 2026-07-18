import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { isImageGenerationError } from './contract.js';
import { validateGeneratedImageBase64 } from './image-candidate-validation.js';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('fake-jpeg-body'),
]);

const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('fake-webp-body'),
]);

void test('validateGeneratedImageBase64 sniffs mime from magic bytes and computes digest', () => {
  const asset = validateGeneratedImageBase64({
    dataBase64: PNG_BYTES.toString('base64'),
  });

  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.byteLength, PNG_BYTES.length);
  assert.equal(asset.digest.algorithm, 'sha256');
  assert.equal(asset.digest.encoding, 'hex');
  assert.equal(
    asset.digest.value,
    createHash('sha256').update(PNG_BYTES).digest('hex'),
  );

  assert.equal(
    validateGeneratedImageBase64({ dataBase64: JPEG_BYTES.toString('base64') })
      .mimeType,
    'image/jpeg',
  );
  assert.equal(
    validateGeneratedImageBase64({ dataBase64: WEBP_BYTES.toString('base64') })
      .mimeType,
    'image/webp',
  );
});

void test('validateGeneratedImageBase64 rejects unsupported bytes as candidate_validation failure', () => {
  try {
    validateGeneratedImageBase64({
      dataBase64: Buffer.from('plain text, not an image').toString('base64'),
    });
    assert.fail('expected candidate validation to throw');
  } catch (error: unknown) {
    assert.ok(isImageGenerationError(error));
    assert.equal(error.surface, 'candidate_validation');
    assert.equal(error.reasonCode, 'unsupported_image_format');
  }
});

void test('validateGeneratedImageBase64 enforces max byte policy', () => {
  try {
    validateGeneratedImageBase64({
      dataBase64: PNG_BYTES.toString('base64'),
      maxBytes: 4,
    });
    assert.fail('expected size policy to throw');
  } catch (error: unknown) {
    assert.ok(isImageGenerationError(error));
    assert.equal(error.surface, 'candidate_validation');
    assert.equal(error.reasonCode, 'image_too_large');
  }
});

void test('validateGeneratedImageBase64 rejects empty and undecodable data', () => {
  for (const dataBase64 of ['', '   ', '@@not-base64@@']) {
    try {
      validateGeneratedImageBase64({ dataBase64 });
      assert.fail('expected validation to throw');
    } catch (error: unknown) {
      assert.ok(isImageGenerationError(error));
      assert.equal(error.surface, 'candidate_validation');
    }
  }
});
