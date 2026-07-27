import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { assistantMessage } from '../../test-support/transcript-message-fixtures.js';
import { createArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import { estimateTranscriptMessageRowSize } from './assistant-transcript-row-model.js';

void test('message row estimates grow with wrapped prose but not one long code line', () => {
  const proseMessage = assistantMessage('prose-estimate', 'x'.repeat(280));
  const longUserPrompt: ThreadMessage = {
    entryId: 'user-prompt-estimate',
    role: 'user',
    content: 'x'.repeat(280),
    timestamp: '2026-07-20T00:00:00.000Z',
  };
  const codeMessage = assistantMessage(
    'code-estimate',
    `\`\`\`ts\n${'x'.repeat(1_000)}\n\`\`\``,
  );
  const reasoningMessage: ThreadMessage = {
    ...assistantMessage('reasoning-estimate', 'x'.repeat(10_000)),
    metadata: { phase: 'commentary' },
  };

  assert.equal(estimateTranscriptMessageRowSize(proseMessage, new Map()), 280);
  assert.equal(
    estimateTranscriptMessageRowSize(longUserPrompt, new Map()),
    280,
  );
  assert.equal(estimateTranscriptMessageRowSize(codeMessage, new Map()), 140);
  assert.equal(
    estimateTranscriptMessageRowSize(reasoningMessage, new Map()),
    44,
  );
});
void test('assistant row estimates include inline images added after text caching', () => {
  const artifactId = 'artifact-inline-image';
  const message: ThreadMessage = {
    ...assistantMessage('inline-image-estimate', 'Image ready.'),
    metadata: {
      phase: 'final_answer',
      activeArtifactRef: { artifactId, version: 1 },
    },
  };
  const artifact: ThreadArtifactVersion = {
    artifactId,
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'image',
    payload: JSON.stringify({
      schemaVersion: 1,
      kind: 'generated_image',
      mimeType: 'image/png',
      byteLength: 8,
      digest: { algorithm: 'sha256', encoding: 'hex', value: 'ab12' },
      source: { type: 'inline_base64', dataBase64: 'cG5nLWJvZHk=' },
      provenance: {
        providerId: 'test',
        model: 'test-image-model',
        capability: 'image_generation',
        prompt: 'a pelican',
        generatedAt: '2026-07-20T00:00:00.000Z',
      },
    }),
    digest: 'digest-inline-image',
    contentHash: 'hash-inline-image',
    createdAt: '2026-07-20T00:00:00.000Z',
    createdByRunId: 'run-inline-image',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: null,
  };

  assert.equal(estimateTranscriptMessageRowSize(message, new Map()), 120);
  assert.equal(
    estimateTranscriptMessageRowSize(
      message,
      createArtifactsByRefMap([artifact]),
    ),
    600,
  );
});
