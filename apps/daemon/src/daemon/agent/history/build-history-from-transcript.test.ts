import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactRefKey } from '@geulbat/protocol/artifacts';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type {
  ThreadMessage,
  ThreadMessageInput,
} from '@geulbat/protocol/threads';

import { buildHistoryFromTranscript } from './build-history-from-transcript.js';

type TestTranscriptEntry = ThreadMessageInput;

function createTranscript(entries: TestTranscriptEntry[]): ThreadMessage[] {
  return entries.map((entry, index) => {
    const entryId = `entry-${index + 1}`;
    if (entry.role === 'compaction') {
      return { ...entry, entryId };
    }
    return { ...entry, entryId };
  });
}

void test('buildHistoryFromTranscript reconstructs structured history from transcript entries', () => {
  const transcript = createTranscript([
    {
      role: 'user',
      content: '안녕',
      timestamp: '2026-03-23T00:00:00.000Z',
    },
    {
      role: 'assistant',
      content: '안녕하세요',
      timestamp: '2026-03-23T00:00:01.000Z',
    },
    {
      role: 'tool_call',
      content: JSON.stringify({
        id: 'fc_1',
        callId: 'call_1',
        tool: 'read_file',
        args: { path: 'hello.txt' },
      }),
      timestamp: '2026-03-23T00:00:02.000Z',
    },
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call_1',
        output: '{"content":"hello"}',
      }),
      timestamp: '2026-03-23T00:00:03.000Z',
    },
  ]);

  assert.deepEqual(buildHistoryFromTranscript(transcript), [
    { kind: 'user', text: '안녕' },
    { kind: 'assistant', phase: 'final_answer', text: '안녕하세요' },
    {
      kind: 'function_call',
      id: 'fc_1',
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"hello.txt"}',
    },
    {
      kind: 'function_call_output',
      callId: 'call_1',
      output: '{"content":"hello"}',
    },
  ]);
});

void test('buildHistoryFromTranscript replays stored recoverable output bytes without normalization', () => {
  const outputRef = 'tool-output:thread-replay/run-replay/call-replay';
  const storedOutput = JSON.stringify({
    status: 'exit',
    stdout: 'large output'.repeat(10_000),
    outputRef,
    fullOutputBytes: 120_000,
    fullOutputChars: 120_000,
  });
  const transcript = createTranscript([
    {
      role: 'tool_call',
      content: JSON.stringify({
        id: 'fc_replay',
        callId: 'call_replay',
        tool: 'exec_command',
        args: { cmd: 'rg pattern .' },
      }),
      timestamp: '2026-03-23T00:00:02.000Z',
    },
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call_replay',
        output: storedOutput,
      }),
      timestamp: '2026-03-23T00:00:03.000Z',
    },
  ]);

  const history = buildHistoryFromTranscript(transcript);
  assert.equal(history[1]?.kind, 'function_call_output');
  if (history[1]?.kind !== 'function_call_output') {
    throw new Error('expected function_call_output');
  }
  assert.equal(history[1].output, storedOutput);
});

void test('buildHistoryFromTranscript preserves legacy tool_call ids for replay sanitization downstream', () => {
  const transcript = createTranscript([
    {
      role: 'tool_call',
      content: JSON.stringify({
        callId: 'call_legacy123',
        tool: 'read_file',
        args: { path: 'hello.txt' },
      }),
      timestamp: '2026-03-23T00:00:02.000Z',
    },
  ]);

  assert.deepEqual(buildHistoryFromTranscript(transcript), [
    {
      kind: 'function_call',
      id: 'call_legacy123',
      callId: 'call_legacy123',
      name: 'read_file',
      arguments: '{"path":"hello.txt"}',
    },
  ]);
});

void test('buildHistoryFromTranscript ignores malformed tool transcript records without casts', () => {
  const transcript = createTranscript([
    {
      role: 'tool_call',
      content: JSON.stringify(['not', 'a', 'record']),
      timestamp: '2026-03-23T00:00:02.000Z',
    },
    {
      role: 'tool_call',
      content: JSON.stringify({
        callId: 1,
        tool: 'read_file',
        args: { path: 'hello.txt' },
      }),
      timestamp: '2026-03-23T00:00:03.000Z',
    },
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 1,
        output: '{"content":"hello"}',
      }),
      timestamp: '2026-03-23T00:00:04.000Z',
    },
  ]);

  assert.deepEqual(buildHistoryFromTranscript(transcript), []);
});

void test('buildHistoryFromTranscript preserves object tool_result output fallback', () => {
  const transcript = createTranscript([
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call_without_output',
        ok: false,
        errorCode: 'invalid_args',
        error: 'bad input',
      }),
      timestamp: '2026-03-23T00:00:03.000Z',
    },
  ]);

  assert.deepEqual(buildHistoryFromTranscript(transcript), [
    {
      kind: 'function_call_output',
      callId: 'call_without_output',
      output: JSON.stringify({
        callId: 'call_without_output',
        ok: false,
        errorCode: 'invalid_args',
        error: 'bad input',
      }),
    },
  ]);
});

void test('buildHistoryFromTranscript skips audit-only PTC callback records', () => {
  const transcript = createTranscript([
    {
      role: 'tool_call',
      content: JSON.stringify({
        id: 'call_parent::nested-1',
        callId: 'call_parent::nested-1',
        tool: 'read_file',
        args: { path: 'hello.txt' },
        source: {
          kind: 'ptc_callback',
          parentToolCallId: 'call_parent',
          runtimeToolCallId: 'runtime-1',
          hostCallId: 'call_parent::nested-1',
        },
        historyMode: 'audit_only',
      }),
      timestamp: '2026-03-23T00:00:02.000Z',
    },
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call_parent::nested-1',
        tool: 'read_file',
        ok: true,
        output: '{"content":"hello"}',
        historyMode: 'audit_only',
      }),
      timestamp: '2026-03-23T00:00:03.000Z',
    },
  ]);

  assert.deepEqual(buildHistoryFromTranscript(transcript), []);
});

void test('buildHistoryFromTranscript skips an audit-only tool_result when the call record is absent', () => {
  const transcript = createTranscript([
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call_parent::nested-1',
        tool: 'read_file',
        ok: true,
        output: '{"content":"hello"}',
        historyMode: 'audit_only',
      }),
      timestamp: '2026-03-23T00:00:03.000Z',
    },
  ]);

  assert.deepEqual(buildHistoryFromTranscript(transcript), []);
});

void test('buildHistoryFromTranscript uses hiddenPrompt for user replay when transcript content is display-only', () => {
  const transcript = createTranscript([
    {
      role: 'user',
      content: 'Apply artifact to episodes/ch01.md',
      timestamp: '2026-03-23T00:00:00.000Z',
      metadata: {
        hiddenPrompt:
          'Apply this artifact preview to the current file.\n<artifact>\n# hello\n</artifact>',
      },
    },
  ]);

  assert.deepEqual(buildHistoryFromTranscript(transcript), [
    {
      kind: 'user',
      text: 'Apply this artifact preview to the current file.\n<artifact>\n# hello\n</artifact>',
    },
  ]);
});

void test('buildHistoryFromTranscript carries assistant artifact refs as object summaries, not legacy envelopes', () => {
  const transcript = createTranscript([
    {
      role: 'assistant',
      content: '',
      timestamp: '2026-04-10T00:00:00.000Z',
      metadata: {
        phase: 'final_answer',
        artifactRefs: [{ artifactId: 'art_1', version: 1 }],
        activeArtifactRef: { artifactId: 'art_1', version: 1 },
      },
    },
  ]);
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# hello',
    digest: '요약',
    contentHash: 'hash',
    createdAt: '2026-04-10T00:00:00.000Z',
    createdByRunId: 'run_1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: null,
  };

  assert.deepEqual(
    buildHistoryFromTranscript(
      transcript,
      new Map([
        [createArtifactRefKey({ artifactId: 'art_1', version: 1 }), artifact],
      ]),
    ),
    [
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: [
          '[Committed artifact]',
          'artifactRef: art_1@1',
          'renderer: markdown',
          'digest: 요약',
          'payload:',
          '# hello',
        ].join('\n'),
      },
    ],
  );
});

void test('buildHistoryFromTranscript omits image artifact payload from history carry text', () => {
  const transcript = createTranscript([
    {
      role: 'assistant',
      content: '이미지를 생성했어요.',
      timestamp: '2026-07-05T00:00:00.000Z',
      metadata: {
        phase: 'final_answer',
        artifactRefs: [{ artifactId: 'art_img', version: 1 }],
        activeArtifactRef: { artifactId: 'art_img', version: 1 },
      },
    },
  ]);
  const hugeBase64Manifest = JSON.stringify({
    schemaVersion: 1,
    kind: 'generated_image',
    source: { type: 'inline_base64', dataBase64: 'x'.repeat(1_000_000) },
  });
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_img',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'image',
    payload: hugeBase64Manifest,
    digest: 'img-digest',
    contentHash: 'hash',
    createdAt: '2026-07-05T00:00:00.000Z',
    createdByRunId: 'run_1',
    previewValidation: { ok: true },
    title: '눈 오는 골목길',
    persistenceEpoch: 0,
    sourceRef: null,
  };

  const history = buildHistoryFromTranscript(
    transcript,
    new Map([
      [createArtifactRefKey({ artifactId: 'art_img', version: 1 }), artifact],
    ]),
  );

  assert.equal(history.length, 1);
  const item = history[0];
  assert.ok(item && item.kind === 'assistant');
  assert.ok(item.text.includes('artifactRef: art_img@1'));
  assert.ok(item.text.includes('renderer: image'));
  assert.ok(item.text.includes('title: 눈 오는 골목길'));
  // 수 MB base64 매니페스트가 모델 히스토리로 재주입되면 안 된다.
  assert.ok(!item.text.includes('x'.repeat(64)));
  assert.ok(item.text.length < 1_000);
});

void test('buildHistoryFromTranscript attaches preloaded user attachment contents by id', () => {
  const transcript = createTranscript([
    {
      role: 'user',
      content: '이 이미지 좀 봐줘',
      timestamp: '2026-03-23T00:00:00.000Z',
      metadata: {
        attachments: [
          {
            attachmentId: 'a2c3f1de-0000-4000-8000-000000000001',
            name: '증상.png',
            mimeType: 'image/png',
            kind: 'image',
            byteLength: 5,
          },
          {
            attachmentId: 'a2c3f1de-0000-4000-8000-000000000002',
            name: '유실.png',
            mimeType: 'image/png',
            kind: 'image',
            byteLength: 5,
          },
        ],
      },
    },
  ]);

  const history = buildHistoryFromTranscript(
    transcript,
    new Map(),
    new Map([
      [
        'a2c3f1de-0000-4000-8000-000000000001',
        {
          kind: 'image' as const,
          name: '증상.png',
          mimeType: 'image/png',
          dataBase64: 'aGVsbG8=',
        },
      ],
    ]),
  );

  assert.deepEqual(history, [
    {
      kind: 'user',
      text: '이 이미지 좀 봐줘',
      // 스토어에서 유실된 두 번째 첨부는 조용히 생략된다
      attachments: [
        {
          kind: 'image',
          name: '증상.png',
          mimeType: 'image/png',
          dataBase64: 'aGVsbG8=',
        },
      ],
    },
  ]);
});
