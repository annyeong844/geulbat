import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCommandSessionHost } from '../command-host/session-core.js';
import type { CommandSessionHost } from '../command-host/contract.js';
import type { DockerClientCommandRunner } from './docker-client-command.js';
import { createHostRoutedDockerCommandRunner } from './docker-host-command.js';

// P7.6 item 4 — host로 라우팅된 docker 러너가 command-host 스냅샷을
// DockerClientCommandResult(react-bundle이 읽는 계약)로 되돌리는지, 실제 인라인
// 세션에 실제 자식(node)을 물려 각 kind 매핑을 증명한다. docker 자리에 node를
// 두는 건 종료·타임아웃·취소·출력상한을 결정적으로 만들 수 있기 때문이다 —
// 매핑이 검증 대상이지 docker 자체가 아니다.

async function makeRunner(
  t: { after(fn: () => Promise<void> | void): void },
  config: {
    inlineMaxBytes?: number;
    maxYieldTimeMs?: number;
    /** 생략하면 react-bundle 모양(진단 상한 = inline 예산). false면 PTC 모양(상한 없음). */
    diagnosticCap?: boolean;
  } = {},
): Promise<{ run: DockerClientCommandRunner; host: CommandSessionHost }> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-docker-host-'));
  const inlineMaxBytes = config.inlineMaxBytes ?? 1024;
  const host = createCommandSessionHost({
    inlineMaxBytes,
    tailRingBytes: 4096,
    ...(config.maxYieldTimeMs === undefined
      ? {}
      : { maxYieldTimeMs: config.maxYieldTimeMs }),
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  const run = createHostRoutedDockerCommandRunner({
    hostCommands: host,
    stateRoot,
    pageLimitBytes: inlineMaxBytes,
    ...(config.diagnosticCap === false
      ? {}
      : { maxOutputBytes: inlineMaxBytes }),
  });
  return { run, host };
}

void test('maps a clean exit to kind exit with output on both streams', async (t) => {
  const { run } = await makeRunner(t);
  const result = await run({
    executable: process.execPath,
    args: [
      '-e',
      "process.stdout.write('ok-out'); process.stderr.write('ok-err')",
    ],
  });
  assert.equal(result.kind, 'exit');
  if (result.kind === 'exit') {
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ok-out');
    assert.equal(result.stderr, 'ok-err');
  }
});

void test('carries a non-zero exit code through', async (t) => {
  const { run } = await makeRunner(t);
  const result = await run({
    executable: process.execPath,
    args: ['-e', 'process.exit(3)'],
  });
  assert.equal(result.kind, 'exit');
  if (result.kind === 'exit') {
    assert.equal(result.exitCode, 3);
  }
});

void test('maps an elapsed timeout to kind timeout', async (t) => {
  const { run } = await makeRunner(t);
  const result = await run({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 200,
  });
  assert.equal(result.kind, 'timeout');
});

void test('returns cancelled without starting when already aborted', async (t) => {
  const { run } = await makeRunner(t);
  const result = await run({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("never")'],
    signal: AbortSignal.abort(),
  });
  assert.equal(result.kind, 'cancelled');
  if (result.kind === 'cancelled') {
    assert.equal(result.stderr, 'docker command cancelled');
  }
});

void test('maps a mid-run abort to cancelled', async (t) => {
  const { run } = await makeRunner(t);
  const controller = new AbortController();
  // 스스로 끝나지 않는 명령 — 완료와 취소가 경합하지 않는다.
  const pending = run({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.kind, 'cancelled');
});

void test('maps an output cap breach to output_limit_exceeded', async (t) => {
  const { run } = await makeRunner(t);
  const result = await run({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(100))"],
    outputBufferPolicy: { maxBufferedBytesPerStream: 16 },
  });
  assert.equal(result.kind, 'output_limit_exceeded');
  if (result.kind === 'output_limit_exceeded') {
    assert.equal(result.stream, 'stdout');
    assert.equal(result.maxBufferedBytesPerStream, 16);
  }
});

void test('maps a missing executable to a non-zero exit (docker unavailable)', async (t) => {
  const { run } = await makeRunner(t);
  const result = await run({
    executable: join(tmpdir(), 'geulbat-nonexistent-docker-xyz'),
    args: ['--version'],
  });
  // command-host의 POSIX exec 게이트는 없는 실행파일을 spawn 크래시가 아니라
  // sh의 exec 실패(비영점 종료)로 낸다. react-bundle의 dockerUnavailableResult는
  // exit 비영점과 crash를 똑같이 docker_unavailable로 읽으므로 계약은 유지된다.
  assert.equal(result.kind, 'exit');
  if (result.kind === 'exit') {
    assert.notEqual(result.exitCode, 0);
  }
});

void test('maps a closed runtime to kind crash', async (t) => {
  const { run, host } = await makeRunner(t);
  await host.closeAll();
  const result = await run({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("x")'],
  });
  assert.equal(result.kind, 'crash');
});

void test('reads output through the page fallback when it exceeds the inline budget', async (t) => {
  // inline 예산을 넘기면 스냅샷 inline이 비어 page 경로로 회수한다 — 진단은 상한
  // 만큼만 담긴다. 예산(host)과 회수 상한(runner)이 같으므로 page 요청이 거부되지
  // 않는다(프로덕션 불변식: 둘 다 같은 env 출처).
  const { run } = await makeRunner(t, { inlineMaxBytes: 8 });
  const result = await run({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('0123456789ABCDEF')"],
  });
  assert.equal(result.kind, 'exit');
  if (result.kind === 'exit') {
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '01234567');
  }
});

void test('recovers the full result when the consumer sets no diagnostic cap', async (t) => {
  // PTC는 docker 출력을 결과로 쓴다(exec stdout·컨테이너 id·설치 로그) — inline 예산은
  // 페이지 크기일 뿐이므로 그보다 큰 성공 출력도 전부 돌아와야 한다.
  const { run } = await makeRunner(t, {
    inlineMaxBytes: 4 * 1024,
    diagnosticCap: false,
  });
  const result = await run({
    executable: process.execPath,
    args: [
      '-e',
      "process.stdout.write('o'.repeat(80 * 1024)); process.stderr.write('e'.repeat(80 * 1024))",
    ],
  });
  assert.equal(result.kind, 'exit');
  if (result.kind === 'exit') {
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stdout, 'utf8'), 80 * 1024);
    assert.equal(Buffer.byteLength(result.stderr, 'utf8'), 80 * 1024);
  }
});

void test('still fails closed when a capless consumer breaches its stream cap', async (t) => {
  // 상한 없는 회수가 무제한 버퍼링을 뜻하지는 않는다 — 호출자가 건 스트림 상한은
  // 여전히 잘린 성공이 아니라 실패로 드러난다.
  const { run } = await makeRunner(t, {
    inlineMaxBytes: 64,
    diagnosticCap: false,
  });
  const result = await run({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(200))"],
    outputBufferPolicy: { maxBufferedBytesPerStream: 32 },
  });
  assert.equal(result.kind, 'output_limit_exceeded');
  if (result.kind === 'output_limit_exceeded') {
    assert.equal(result.maxBufferedBytesPerStream, 32);
  }
});

void test('polls to terminal when the command outlives the first yield window', async (t) => {
  // 즉시 출력 후 조용히 살아 있다가 종료 — waitForInitialResult가 terminal 전에
  // 돌아와 폴링 루프를 강제한다. 조용한 running 구간(revision 정체)에서도 crash로
  // 오판하지 않고 terminal까지 기다려야 한다.
  const { run } = await makeRunner(t, { maxYieldTimeMs: 50 });
  const result = await run({
    executable: process.execPath,
    args: [
      '-e',
      "process.stdout.write('start'); setTimeout(() => process.exit(0), 250)",
    ],
  });
  assert.equal(result.kind, 'exit');
  if (result.kind === 'exit') {
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'start');
  }
});
