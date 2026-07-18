import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { FinalAnswerThreadMessageMetadata } from '@geulbat/protocol/thread-metadata';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { brandThreadId } from '../../lib/id-brand-helpers.js';
import {
  createArtifactsByRefMap,
  readCommittedMessageArtifact,
} from './artifact-transcript-lookup.js';

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

void test('createArtifactsByRefMap indexes committed artifacts by id and version', () => {
  const firstVersion = createThreadArtifactVersion({
    artifactId: 'artifact_1',
    version: 1,
  });
  const secondVersion = createThreadArtifactVersion({
    artifactId: 'artifact_1',
    version: 2,
  });
  const artifactsByRef = createArtifactsByRefMap([firstVersion, secondVersion]);

  assert.equal(
    readCommittedMessageArtifact(
      createAssistantMessage({
        activeArtifactRef: { artifactId: 'artifact_1', version: 1 },
      }),
      artifactsByRef,
    ),
    firstVersion,
  );
  assert.equal(
    readCommittedMessageArtifact(
      createAssistantMessage({
        activeArtifactRef: { artifactId: 'artifact_1', version: 2 },
      }),
      artifactsByRef,
    ),
    secondVersion,
  );
});

void test('readCommittedMessageArtifact prefers active refs over older artifact refs', () => {
  const olderArtifact = createThreadArtifactVersion({
    artifactId: 'artifact_older',
    version: 1,
  });
  const activeArtifact = createThreadArtifactVersion({
    artifactId: 'artifact_active',
    version: 3,
  });

  assert.equal(
    readCommittedMessageArtifact(
      createAssistantMessage({
        artifactRefs: [
          { artifactId: 'artifact_older', version: 1 },
          { artifactId: 'artifact_active', version: 3 },
        ],
        activeArtifactRef: { artifactId: 'artifact_active', version: 3 },
      }),
      createArtifactsByRefMap([olderArtifact, activeArtifact]),
    ),
    activeArtifact,
  );
});

void test('readCommittedMessageArtifact falls back to the first available committed ref', () => {
  const artifact = createThreadArtifactVersion({
    artifactId: 'artifact_found',
    version: 4,
  });

  assert.equal(
    readCommittedMessageArtifact(
      createAssistantMessage({
        artifactRefs: [
          { artifactId: 'artifact_missing', version: 1 },
          { artifactId: 'artifact_found', version: 4 },
        ],
      }),
      createArtifactsByRefMap([artifact]),
    ),
    artifact,
  );
});

void test('readCommittedMessageArtifact ignores non-assistant messages and missing refs', () => {
  const artifact = createThreadArtifactVersion({
    artifactId: 'artifact_1',
    version: 1,
  });
  const artifactsByRef = createArtifactsByRefMap([artifact]);

  assert.equal(
    readCommittedMessageArtifact(
      {
        entryId: 'entry-user-missing-ref',
        role: 'user',
        content: 'show me this',
        timestamp: '2026-04-29T00:00:00.000Z',
        metadata: {
          hiddenPrompt: 'show me this',
        },
      },
      artifactsByRef,
    ),
    null,
  );
  assert.equal(
    readCommittedMessageArtifact(
      createAssistantMessage({
        activeArtifactRef: { artifactId: 'artifact_missing', version: 1 },
      }),
      artifactsByRef,
    ),
    null,
  );
});

function createAssistantMessage(
  overrides: Partial<FinalAnswerThreadMessageMetadata> = {},
): ThreadMessage {
  return {
    entryId: 'entry-assistant-artifact',
    role: 'assistant',
    content: 'artifact ready',
    timestamp: '2026-04-29T00:00:00.000Z',
    metadata: {
      phase: 'final_answer',
      ...overrides,
    },
  };
}

function createThreadArtifactVersion(
  overrides: Pick<ThreadArtifactVersion, 'artifactId' | 'version'>,
): ThreadArtifactVersion {
  return {
    artifactId: overrides.artifactId,
    version: overrides.version,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# artifact',
    digest: `digest-${overrides.artifactId}-${overrides.version}`,
    contentHash: `hash-${overrides.artifactId}-${overrides.version}`,
    createdAt: '2026-04-29T00:00:00.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories/sample',
      threadId: THREAD_ID,
      runId: 'run-1',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-29T00:00:00.000Z',
    },
  };
}
