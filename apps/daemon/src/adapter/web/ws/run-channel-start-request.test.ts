import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ThreadId } from '@geulbat/protocol/ids';

import { writeRunPromptInputRefFromStream } from '../../../daemon/sessions/prompt-input-ref-store.js';
import { readRunStartRequest } from './run-channel-start-request.js';

async function createArgs(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-run-start-request-'));
  const homeStateRoot = join(root, 'home-state');
  const browseStartPath = 'workspace/writer';
  await mkdir(homeStateRoot, { recursive: true });
  await mkdir(join(root, browseStartPath), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    homeStateRoot,
    computerFileScope: {
      root,
      browseStartPath,
      browseShortcuts: [],
    },
  };
}

void test('readRunStartRequest rejects blank prompts', async (t) => {
  assert.deepEqual(
    await readRunStartRequest({ prompt: '   ' }, await createArgs(t)),
    {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    },
  );
});

void test('readRunStartRequest rejects working directories outside the computer root', async (t) => {
  assert.deepEqual(
    await readRunStartRequest(
      { prompt: 'hello', workingDirectory: '../escape' },
      await createArgs(t),
    ),
    {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'invalid workingDirectory',
    },
  );
});

void test('readRunStartRequest rejects absolute and escaping current file paths', async (t) => {
  const args = await createArgs(t);
  for (const currentFile of [
    '/workspace/writer/novel.md',
    'D:\\workspace\\writer\\novel.md',
    '../novel.md',
  ]) {
    assert.deepEqual(
      await readRunStartRequest({ prompt: 'hello', currentFile }, args),
      {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'invalid currentFile',
      },
      currentFile,
    );
  }
});

void test('readRunStartRequest canonicalizes a portable current file path', async (t) => {
  const args = await createArgs(t);
  const result = await readRunStartRequest(
    {
      prompt: 'hello',
      currentFile: 'workspace\\writer\\drafts\\..\\novel.md',
    },
    args,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.currentFile, 'workspace/writer/novel.md');
});

void test('readRunStartRequest rejects malformed thread ids', async (t) => {
  assert.deepEqual(
    await readRunStartRequest(
      {
        prompt: 'hello',
        threadId: '../bad-thread' as unknown as ThreadId,
      },
      await createArgs(t),
    ),
    {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'invalid threadId',
    },
  );
});

void test('readRunStartRequest admits an explicit computer-root-relative working directory', async (t) => {
  const args = await createArgs(t);
  await mkdir(join(args.computerFileScope.root, 'work', 'novel'), {
    recursive: true,
  });
  const result = await readRunStartRequest(
    {
      prompt: 'hello',
      displayPrompt: '  shown prompt  ',
      workingDirectory: 'work/novel',
      permissionMode: 'full_access',
    },
    args,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.prompt, 'hello');
  assert.equal(result.value.transcriptPrompt, 'shown prompt');
  assert.equal(result.value.workingDirectory, 'work/novel');
  assert.equal(result.value.permissionMode, 'full_access');
});

void test('readRunStartRequest defaults working directory to the computer browse start path', async (t) => {
  const args = await createArgs(t);
  const result = await readRunStartRequest(
    { prompt: 'hello', modelId: 'grok-4.5' },
    args,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.value.workingDirectory,
    args.computerFileScope.browseStartPath,
  );
  assert.equal(result.value.modelId, 'grok-4.5');
});

void test('readRunStartRequest preserves the image generation model selection', async (t) => {
  const args = await createArgs(t);
  const result = await readRunStartRequest(
    {
      prompt: 'hello',
      imageGenerationModel: 'grok-imagine-image-quality',
    },
    args,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.imageGenerationModel, 'grok-imagine-image-quality');

  const withoutSelection = await readRunStartRequest({ prompt: 'hello' }, args);
  assert.equal(withoutSelection.ok, true);
  if (!withoutSelection.ok) return;
  assert.equal(withoutSelection.value.imageGenerationModel, undefined);
});

void test('readRunStartRequest preserves the video generation model and settings', async (t) => {
  const args = await createArgs(t);
  const result = await readRunStartRequest(
    {
      prompt: 'hello',
      videoGenerationModel: 'grok-imagine-video-1.5',
      videoGenerationSettings: { durationSeconds: 10 },
    },
    args,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.videoGenerationModel, 'grok-imagine-video-1.5');
  assert.deepEqual(result.value.videoGenerationSettings, {
    durationSeconds: 10,
  });

  const withoutSelection = await readRunStartRequest({ prompt: 'hello' }, args);
  assert.equal(withoutSelection.ok, true);
  if (!withoutSelection.ok) return;
  assert.equal(withoutSelection.value.videoGenerationModel, undefined);
  assert.equal(withoutSelection.value.videoGenerationSettings, undefined);
});

void test('readRunStartRequest resolves Home prompt refs before normalizing transcript prompt', async (t) => {
  const args = await createArgs(t);
  const written = await writeRunPromptInputRefFromStream({
    workspaceRoot: args.homeStateRoot,
    input: Readable.from(['stored prompt']),
  });

  const result = await readRunStartRequest(
    {
      promptRef: written.promptRef,
      displayPrompt: '  visible prompt  ',
    },
    args,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.prompt, 'stored prompt');
  assert.equal(result.value.transcriptPrompt, 'visible prompt');
  assert.equal(result.value.promptRef?.promptRef, written.promptRef);
});
