import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isThreadMessageMetadata,
  isThreadMessagePhase,
  readActiveArtifactRefFromMetadata,
  readArtifactRefsFromMetadata,
  type ThreadMessageMetadata,
} from './thread-metadata.js';

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type _MetadataRejectsOpaqueRecords = Expect<
  Equal<{ kind: 'final' } extends ThreadMessageMetadata ? true : false, false>
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

void test('thread message metadata accepts interject source metadata', () => {
  const metadata: ThreadMessageMetadata = {
    source: 'interject',
  };

  assert.equal(isThreadMessageMetadata(metadata), true);
  assert.equal(readArtifactRefsFromMetadata(metadata).length, 0);
  assert.equal(readActiveArtifactRefFromMetadata(metadata), null);
});

void test('thread message metadata accepts commentary metadata', () => {
  const metadata: ThreadMessageMetadata = {
    phase: 'commentary',
    sourceRunId: 'run-thread-metadata-commentary',
  };

  assert.equal(isThreadMessageMetadata(metadata), true);
  assert.equal(isThreadMessagePhase(metadata.phase), true);
  assert.equal(readArtifactRefsFromMetadata(metadata).length, 0);
  assert.equal(readActiveArtifactRefFromMetadata(metadata), null);
});

void test('thread message metadata accepts final-answer artifact refs', () => {
  const metadata: ThreadMessageMetadata = {
    phase: 'final_answer',
    sourceRunId: 'run-thread-metadata-1',
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

void test('thread message metadata rejects invalid known-key payloads', () => {
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
