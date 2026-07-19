import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isThreadMessageMetadata,
  isThreadMessagePhase,
  readActiveArtifactRefFromMetadata,
  readArtifactRefsFromMetadata,
  type ThreadMessageMetadata,
} from './thread-metadata.js';
import { assertRunId } from './ids.js';

const COMMENTARY_RUN_ID = assertRunId('run-thread-metadata-commentary');
const FINAL_RUN_ID = assertRunId('run-thread-metadata-1');

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type _MetadataRejectsOpaqueRecords = Expect<
  Equal<{ kind: 'final' } extends ThreadMessageMetadata ? true : false, false>
>;

type _MetadataRejectsUnbrandedSourceRunId = Expect<
  Equal<
    {
      phase: 'final_answer';
      sourceRunId: string;
    } extends ThreadMessageMetadata
      ? true
      : false,
    false
  >
>;

type _FinalAnswerMetadataRejectsHiddenPrompt = Expect<
  Equal<
    {
      phase: 'final_answer';
      hiddenPrompt: 'prompt';
    } extends ThreadMessageMetadata
      ? true
      : false,
    false
  >
>;

type _InterjectMetadataRejectsHiddenPrompt = Expect<
  Equal<
    {
      source: 'interject';
      hiddenPrompt: 'prompt';
    } extends ThreadMessageMetadata
      ? true
      : false,
    false
  >
>;

void test('thread message metadata accepts user hidden-prompt metadata', () => {
  const metadata: ThreadMessageMetadata = {
    hiddenPrompt: 'canonical prompt',
  };

  assert.equal(isThreadMessageMetadata(metadata), true);
  assert.equal(readArtifactRefsFromMetadata(metadata).length, 0);
  assert.equal(readActiveArtifactRefFromMetadata(metadata), null);
});

void test('thread message metadata accepts user attachment records', () => {
  const metadata: ThreadMessageMetadata = {
    attachments: [
      {
        attachmentId: 'a2c3f1de-0000-4000-8000-000000000001',
        name: '증상.png',
        mimeType: 'image/png',
        kind: 'image',
        byteLength: 1024,
      },
    ],
  };

  assert.equal(isThreadMessageMetadata(metadata), true);

  // hiddenPrompt와 attachments가 함께 있어도 유효
  assert.equal(
    isThreadMessageMetadata({
      hiddenPrompt: 'canonical prompt',
      attachments: metadata.attachments,
    }),
    true,
  );

  // 빈 배열·잘못된 kind는 거부
  assert.equal(isThreadMessageMetadata({ attachments: [] }), false);
  assert.equal(
    isThreadMessageMetadata({
      attachments: [
        {
          attachmentId: 'id',
          name: 'x',
          mimeType: 'image/png',
          kind: 'video',
          byteLength: 1,
        },
      ],
    }),
    false,
  );
});

void test('thread message metadata accepts interject source metadata', () => {
  const metadata: ThreadMessageMetadata = {
    source: 'interject',
  };

  assert.equal(isThreadMessageMetadata(metadata), true);
  assert.equal(readArtifactRefsFromMetadata(metadata).length, 0);
  assert.equal(readActiveArtifactRefFromMetadata(metadata), null);
  assert.equal(
    isThreadMessageMetadata({
      source: 'interject',
      sourceRunId: 'run-thread-metadata-interject',
      receivedSeq: 7,
    }),
    true,
  );
  assert.equal(
    isThreadMessageMetadata({
      source: 'interject',
      sourceRunId: 'run-thread-metadata-interject',
    }),
    false,
  );
  assert.equal(
    isThreadMessageMetadata({ source: 'interject', receivedSeq: 0 }),
    false,
  );
});

void test('thread message metadata accepts commentary metadata', () => {
  const metadata: ThreadMessageMetadata = {
    phase: 'commentary',
    sourceRunId: COMMENTARY_RUN_ID,
  };

  assert.equal(isThreadMessageMetadata(metadata), true);
  assert.equal(isThreadMessagePhase(metadata.phase), true);
  assert.equal(readArtifactRefsFromMetadata(metadata).length, 0);
  assert.equal(readActiveArtifactRefFromMetadata(metadata), null);
});

void test('thread message metadata accepts final-answer artifact refs', () => {
  const metadata: ThreadMessageMetadata = {
    phase: 'final_answer',
    sourceRunId: FINAL_RUN_ID,
    sourceFile: 'episodes/ch01.md',
    artifactRefs: [{ artifactId: 'art_1', version: 1 }],
    activeArtifactRef: { artifactId: 'art_1', version: 1 },
  };

  assert.equal(isThreadMessageMetadata(metadata), true);
  assert.equal(isThreadMessagePhase(metadata.phase), true);
  assert.deepEqual(readArtifactRefsFromMetadata(metadata), [
    { artifactId: 'art_1', version: 1 },
  ]);
  assert.deepEqual(readActiveArtifactRefFromMetadata(metadata), {
    artifactId: 'art_1',
    version: 1,
  });
});

void test('thread message metadata accepts artifact_frame origin on user turns only', () => {
  assert.equal(isThreadMessageMetadata({ origin: 'artifact_frame' }), true);
  assert.equal(
    isThreadMessageMetadata({ silent: true, origin: 'artifact_frame' }),
    true,
  );
  // 미지의 origin 값과 user 외 변형의 origin은 거부한다
  assert.equal(isThreadMessageMetadata({ origin: 'other_surface' }), false);
  assert.equal(
    isThreadMessageMetadata({ phase: 'commentary', origin: 'artifact_frame' }),
    false,
  );
  assert.equal(
    isThreadMessageMetadata({ source: 'interject', origin: 'artifact_frame' }),
    false,
  );
});

void test('thread message metadata rejects invalid known-key payloads', () => {
  assert.equal(
    isThreadMessageMetadata({
      phase: 'final_answer',
      sourceRunId: 'invalid run id',
    }),
    false,
  );

  assert.equal(
    isThreadMessageMetadata({
      phase: 'whatever',
    }),
    false,
  );

  assert.equal(
    isThreadMessageMetadata({
      artifactRefs: [{ artifactId: 'art_1', version: 0 }],
    }),
    false,
  );

  assert.equal(
    isThreadMessageMetadata({
      phase: 'final_answer',
      hiddenPrompt: 'belongs to user metadata only',
    }),
    false,
  );

  assert.equal(
    isThreadMessageMetadata({
      source: 'interject',
      hiddenPrompt: 'interject source stands alone',
    }),
    false,
  );

  assert.equal(
    isThreadMessageMetadata({
      kind: 'final',
    }),
    false,
  );
});
