import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCommandSessionHost } from '../../../command-host/session-core.js';
import type { CommandSessionHost } from '../../../command-host/contract.js';
import {
  createDelimitedFrameReader,
  streamHostRoutedCommandLines,
} from './search-files-host-stream.js';
import { runRipgrep } from './search-files-ripgrep.js';
import { createGlobMatcher, filenameSearch } from './search-files-filename.js';

// P7.6 item 4 — 검색 자식이 워커의 system 세션에서 돌아도 줄 단위 스트림이 무손실로
// 도착하는지, 실제 인라인 세션에 실제 자식(node)을 물려 확인한다. ripgrep 자리에
// node를 두는 건 출력량·종료코드·stderr를 결정적으로 만들 수 있기 때문이다 —
// 검증 대상은 검색 엔진이 아니라 스트림과 종료 판정이다.

async function makeHost(
  t: { after(fn: () => Promise<void> | void): void },
  config: { inlineMaxBytes?: number; tailRingBytes?: number } = {},
): Promise<{ host: CommandSessionHost; stateRoot: string }> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-search-host-'));
  const host = createCommandSessionHost({
    inlineMaxBytes: config.inlineMaxBytes ?? 256,
    tailRingBytes: config.tailRingBytes ?? 4096,
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { host, stateRoot };
}

/** 실제 소비자와 같은 프레이밍으로 줄을 모은다. */
function createLineSink(): {
  lines: string[];
  onStdoutChunk: (chunk: string) => void;
  flush: () => void;
} {
  const lines: string[] = [];
  const frames = createDelimitedFrameReader('\n', (line) => {
    lines.push(line);
  });
  return { lines, onStdoutChunk: frames.consume, flush: frames.flush };
}

void test('delivers every stdout line in order across page boundaries', async (t) => {
  // 페이지 상한보다 훨씬 큰 출력 — 줄이 페이지 경계에서 잘려도 한 줄도 잃거나
  // 쪼개지지 않아야 한다. ripgrep --json은 줄 단위 프레임이라 이것이 곧 일치 개수다.
  const { host, stateRoot } = await makeHost(t, { inlineMaxBytes: 64 });
  const lineCount = 500;
  const sink = createLineSink();
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: host,
    stateRoot,
    executable: process.execPath,
    commandArgs: [
      '-e',
      `for (let i = 0; i < ${String(lineCount)}; i += 1) { process.stdout.write('line-' + i + '\\n'); }`,
    ],
    cwd: stateRoot,
    env: process.env,
    pageLimitBytes: 64,
    onStdoutChunk: sink.onStdoutChunk,
  });
  sink.flush();
  assert.equal(streamed.ok, true);
  if (streamed.ok) {
    assert.equal(streamed.value.status, 'exit');
    assert.equal(streamed.value.exitCode, 0);
  }
  assert.equal(sink.lines.length, lineCount);
  assert.equal(sink.lines[0], 'line-0');
  assert.equal(sink.lines.at(-1), `line-${String(lineCount - 1)}`);
});

void test('delivers a trailing line that has no newline', async (t) => {
  const { host, stateRoot } = await makeHost(t);
  const sink = createLineSink();
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: host,
    stateRoot,
    executable: process.execPath,
    commandArgs: ['-e', "process.stdout.write('first\\nsecond')"],
    cwd: stateRoot,
    env: process.env,
    pageLimitBytes: 256,
    onStdoutChunk: sink.onStdoutChunk,
  });
  sink.flush();
  assert.equal(streamed.ok, true);
  assert.deepEqual(sink.lines, ['first', 'second']);
});

void test('keeps multibyte characters intact across page boundaries', async (t) => {
  // 페이지는 바이트 좌표계다 — 경계에서 UTF-8이 쪼개지면 한글 검색 결과가 조용히
  // 깨진다. 세션의 페이지 계약(§4.3)이 경계까지만 건네는지 실제로 확인한다.
  const { host, stateRoot } = await makeHost(t, { inlineMaxBytes: 16 });
  const sink = createLineSink();
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: host,
    stateRoot,
    executable: process.execPath,
    commandArgs: [
      '-e',
      "for (let i = 0; i < 40; i += 1) { process.stdout.write('한글-줄-' + i + '\\n'); }",
    ],
    cwd: stateRoot,
    env: process.env,
    pageLimitBytes: 16,
    onStdoutChunk: sink.onStdoutChunk,
  });
  sink.flush();
  assert.equal(streamed.ok, true);
  assert.equal(sink.lines.length, 40);
  assert.equal(sink.lines[0], '한글-줄-0');
  assert.equal(sink.lines[39], '한글-줄-39');
  assert.equal(
    sink.lines.some((line) => line.includes('\uFFFD')),
    false,
  );
});

void test('collects stderr while draining stdout and reports a non-zero exit', async (t) => {
  // 두 스트림을 함께 비우지 않으면 진단을 많이 쏟는 자식이 backpressure로 멈춘다.
  const { host, stateRoot } = await makeHost(t, { inlineMaxBytes: 64 });
  const sink = createLineSink();
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: host,
    stateRoot,
    executable: process.execPath,
    commandArgs: [
      '-e',
      "for (let i = 0; i < 60; i += 1) { process.stdout.write('out-' + i + '\\n'); process.stderr.write('warn-' + i + '\\n'); } process.exit(2)",
    ],
    cwd: stateRoot,
    env: process.env,
    pageLimitBytes: 64,
    onStdoutChunk: sink.onStdoutChunk,
  });
  sink.flush();
  assert.equal(streamed.ok, true);
  if (streamed.ok) {
    assert.equal(streamed.value.status, 'exit');
    assert.equal(streamed.value.exitCode, 2);
    assert.equal(streamed.value.stderr.includes('warn-0'), true);
    assert.equal(streamed.value.stderr.includes('warn-59'), true);
  }
  assert.equal(sink.lines.length, 60);
});

void test('cancellation settles the claimed child before returning', async (t) => {
  const { host, stateRoot } = await makeHost(t);
  const controller = new AbortController();
  const pending = streamHostRoutedCommandLines({
    hostCommands: host,
    stateRoot,
    executable: process.execPath,
    // 첫 출력 뒤에는 스스로 끝나지 않는다. stdout callback에서 취소하면
    // unclaimed-discard가 아니라 claimed-session 정리 경로를 검증한다.
    commandArgs: [
      '-e',
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ],
    cwd: stateRoot,
    env: process.env,
    pageLimitBytes: 256,
    onStdoutChunk: () => {
      controller.abort();
    },
    signal: controller.signal,
  });
  const streamed = await pending;
  assert.equal(streamed.ok, false);
  if (!streamed.ok) {
    assert.equal(streamed.aborted, true);
  }
  assert.equal(
    host.listSessions().some((session) => session.running),
    false,
  );
  assert.equal(host.isQuiescent(), true);
});

void test('reports a closed runtime as a failed search rather than empty results', async (t) => {
  const { host, stateRoot } = await makeHost(t);
  await host.closeAll();
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: host,
    stateRoot,
    executable: process.execPath,
    commandArgs: ['-e', "process.stdout.write('x\\n')"],
    cwd: stateRoot,
    env: process.env,
    pageLimitBytes: 256,
    onStdoutChunk: () => {},
  });
  assert.equal(streamed.ok, false);
  if (!streamed.ok) {
    assert.equal(streamed.aborted, false);
  }
});

void test('filenameSearch collects host-routed NUL-delimited paths', async (t) => {
  // ripgrep --files는 경로를 NUL로 구분한다 — 프레이밍이 다른 두 번째 소비자가
  // 같은 스트림 경로에서 한 경로도 잃지 않는지 확인한다.
  if (process.platform === 'win32') {
    t.skip('POSIX exec gate로 대역 실행파일을 띄우는 경로만 검증한다');
    return;
  }
  const { host, stateRoot } = await makeHost(t, { inlineMaxBytes: 32 });
  const names = Array.from({ length: 30 }, (_, index) => `file-${index}.ts`);
  const stubPath = join(stateRoot, 'rg-files-stub');
  await writeFile(
    stubPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
      names.map((name) => `${join(stateRoot, name)}\u0000`).join(''),
    )});\n`,
    { mode: 0o755 },
  );
  const result = await filenameSearch(
    stateRoot,
    stateRoot,
    '*.ts',
    createGlobMatcher('*.ts'),
    null,
    undefined,
    undefined,
    {
      hostRouting: { hostCommands: host, stateRoot, pageLimitBytes: 32 },
      searchFilenameIndex: () =>
        Promise.resolve({
          kind: 'unavailable' as const,
          reasonCode: 'unsupported_root' as const,
        }),
      resolveRipgrepPathForRoot: () => Promise.resolve(stubPath),
    },
  );
  assert.equal(result.total, names.length);
  assert.equal(result.results.length, names.length);
  assert.equal(result.results[0]?.path, 'file-0.ts');
});

void test('runRipgrep parses host-routed matches with the same contract as direct execution', async (t) => {
  // ripgrep --json 모양의 줄을 내는 대역 실행파일로 제품 경로(runRipgrep)를 통과시킨다.
  // 인자를 무시하는 스크립트여야 runRipgrep이 만드는 실제 rg 인자와 무관하게 돈다.
  if (process.platform === 'win32') {
    t.skip('POSIX exec gate로 대역 실행파일을 띄우는 경로만 검증한다');
    return;
  }
  const { host, stateRoot } = await makeHost(t, { inlineMaxBytes: 64 });
  const workspaceRoot = stateRoot;
  const events = [
    {
      type: 'match',
      data: {
        path: { text: join(workspaceRoot, 'a.ts') },
        line_number: 3,
        lines: { text: 'const needle = 1;\n' },
      },
    },
    {
      type: 'begin',
      data: { path: { text: join(workspaceRoot, 'b.ts') } },
    },
    {
      type: 'match',
      data: {
        path: { text: join(workspaceRoot, 'b.ts') },
        line_number: 7,
        lines: { text: 'needle();\n' },
      },
    },
  ];
  const stubPath = join(stateRoot, 'rg-stub');
  await writeFile(
    stubPath,
    `#!/usr/bin/env node\n${events
      .map(
        (event) =>
          `process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`,
      )
      .join('\n')}\n`,
    { mode: 0o755 },
  );

  const result = await runRipgrep(
    stubPath,
    'needle',
    workspaceRoot,
    null,
    workspaceRoot,
    undefined,
    undefined,
    { hostCommands: host, stateRoot, pageLimitBytes: 64 },
  );
  assert.equal(result.backend, 'ripgrep');
  assert.equal(result.query, 'needle');
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.results.map((match) => [match.path, match.line, match.text]),
    [
      ['a.ts', 3, 'const needle = 1;'],
      ['b.ts', 7, 'needle();'],
    ],
  );
});

void test('runRipgrep surfaces a host-routed ripgrep failure instead of empty results', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX exec gate로 대역 실행파일을 띄우는 경로만 검증한다');
    return;
  }
  const { host, stateRoot } = await makeHost(t);
  const stubPath = join(stateRoot, 'rg-failing-stub');
  await writeFile(
    stubPath,
    '#!/usr/bin/env node\nprocess.stderr.write("regex parse error\\n");\nprocess.exit(2);\n',
    { mode: 0o755 },
  );
  await assert.rejects(
    runRipgrep(
      stubPath,
      '(',
      stateRoot,
      null,
      stateRoot,
      undefined,
      undefined,
      { hostCommands: host, stateRoot, pageLimitBytes: 256 },
    ),
    (error: unknown) =>
      error instanceof Error && error.message.includes('regex parse error'),
  );
});
