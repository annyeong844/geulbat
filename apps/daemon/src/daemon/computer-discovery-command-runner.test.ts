import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCommandSessionHost } from '../command-host/session-core.js';
import { createHostRoutedComputerSessionDiscoveryCommandRunner } from './computer-discovery-command-runner.js';
import type { ComputerSessionDiscoveryCommandRunnerAsync } from './files/computer-session-defaults.js';

// P7.6 item 4 — 브라우즈 발견 명령이 데몬의 자식이 아니라 command-host system
// 세션에서 돌아도, 발견 계약({error,status,stdout})이 그대로 유지되는지 실제 인라인
// 세션에 실제 자식을 물려 확인한다. PowerShell/osascript 자리에 node를 두는 건 종료
// 코드·타임아웃·출력상한을 결정적으로 만들 수 있기 때문이다 — 검증 대상은 OS 명령이
// 아니라 계약 번역이다.

async function makeRunner(
  t: { after(fn: () => Promise<void> | void): void },
  config: { inlineMaxBytes?: number } = {},
): Promise<ComputerSessionDiscoveryCommandRunnerAsync> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-discovery-host-'));
  const inlineMaxBytes = config.inlineMaxBytes ?? 1024;
  const host = createCommandSessionHost({
    inlineMaxBytes,
    tailRingBytes: 4096,
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return createHostRoutedComputerSessionDiscoveryCommandRunner({
    hostCommands: host,
    stateRoot,
    inlineMaxBytes,
  });
}

function discoveryInvocation(args: {
  executable: string;
  commandArgs: string[];
  timeoutMs?: number;
  maxBufferBytes?: number;
}): Parameters<ComputerSessionDiscoveryCommandRunnerAsync>[0] {
  return {
    executable: args.executable,
    args: args.commandArgs,
    windowsHide: true,
    timeoutMs: args.timeoutMs ?? 15_000,
    maxBufferBytes: args.maxBufferBytes ?? 1024 * 1024,
  };
}

void test('carries a successful discovery payload with status 0', async (t) => {
  const run = await makeRunner(t);
  const result = await run(
    discoveryInvocation({
      executable: process.execPath,
      commandArgs: ['-e', "process.stdout.write('D:\\\\Projects\\\\geulbat')"],
    }),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'D:\\Projects\\geulbat');
});

void test('reports a non-zero exit as a failed discovery attempt', async (t) => {
  // 발견 계약은 성공을 status 0으로만 인정한다 — 부분 출력이 있어도 파서에 태우지
  // 않고 error로 접어 재시도 수명 주기가 판단하게 한다.
  const run = await makeRunner(t);
  const result = await run(
    discoveryInvocation({
      executable: process.execPath,
      commandArgs: ['-e', "process.stdout.write('partial'); process.exit(2)"],
    }),
  );
  assert.notEqual(result.error, undefined);
  assert.equal(result.status, null);
  assert.equal(result.stdout, 'partial');
});

void test('reports a missing discovery executable as a failure', async (t) => {
  // PowerShell이 없는 리눅스나 osascript가 없는 환경이 정상 경로다 — 데몬이 죽지
  // 않고 발견만 불완전해야 한다.
  const run = await makeRunner(t);
  const result = await run(
    discoveryInvocation({
      executable: join(tmpdir(), 'geulbat-nonexistent-powershell-xyz'),
      commandArgs: ['-NoLogo'],
    }),
  );
  assert.notEqual(result.error, undefined);
  assert.equal(result.status, null);
});

void test('reports an elapsed timeout as a failure', async (t) => {
  const run = await makeRunner(t);
  const result = await run(
    discoveryInvocation({
      executable: process.execPath,
      commandArgs: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 200,
    }),
  );
  assert.notEqual(result.error, undefined);
  assert.equal(result.status, null);
});

void test('recovers output larger than the inline budget in full', async (t) => {
  // 발견 출력은 파서가 전부 읽어야 하는 결과다. 세션 inline 예산(여기선 64B)은
  // 페이지 단위일 뿐이므로, 호출자 상한 안의 출력은 잘리지 않고 전부 돌아와야 한다.
  const run = await makeRunner(t, { inlineMaxBytes: 64 });
  const payloadBytes = 300;
  const result = await run(
    discoveryInvocation({
      executable: process.execPath,
      commandArgs: [
        '-e',
        `process.stdout.write('p'.repeat(${String(payloadBytes)}))`,
      ],
      maxBufferBytes: 4096,
    }),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'p'.repeat(payloadBytes));
});

void test('reports a breach of the caller output cap as a failure', async (t) => {
  // execFile의 maxBuffer 초과가 error였던 것처럼, 상한을 넘긴 출력은 잘린 성공이
  // 아니라 실패로 드러나야 한다.
  const run = await makeRunner(t, { inlineMaxBytes: 64 });
  const result = await run(
    discoveryInvocation({
      executable: process.execPath,
      commandArgs: ['-e', "process.stdout.write('x'.repeat(200))"],
      maxBufferBytes: 32,
    }),
  );
  assert.notEqual(result.error, undefined);
  assert.equal(result.status, null);
});
