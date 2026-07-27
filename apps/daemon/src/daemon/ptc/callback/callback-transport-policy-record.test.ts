import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearStoredPtcCallbackTransportPolicy,
  ptcCallbackTransportPolicyRecordPath,
  PtcCallbackTransportPolicyRecordError,
  readStoredPtcCallbackTransportPolicy,
  resolvePtcCallbackTransportPolicy,
  writeStoredPtcCallbackTransportPolicy,
} from './callback-transport-policy-record.js';

// PTC transition spec v7 §3 (2026-07-27) — 운영자가 확정한 콜백 전송 정책이 어떻게
// 읽히고, 무엇을 거부하며, 환경변수와 어떤 순서로 겹치는지 잠근다. 값을 지어내지
// 않는다는 것(F003)이 계약의 핵심이므로 "부분 저장 거부"와 "손상 시 진단"이 함께 있다.

const COMPLETE_POLICY = {
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
} as const;

async function makeHome(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<string> {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-callback-'));
  t.after(async () => {
    await rm(homeStateRoot, { recursive: true, force: true });
  });
  return homeStateRoot;
}

void test('no record and no environment leaves the callback transport disabled', async (t) => {
  const homeStateRoot = await makeHome(t);
  assert.deepEqual(
    resolvePtcCallbackTransportPolicy({ homeStateRoot, env: {} }),
    {
      source: 'disabled',
    },
  );
});

void test('an operator-confirmed record survives a round trip and reports its source', async (t) => {
  const homeStateRoot = await makeHome(t);
  await writeStoredPtcCallbackTransportPolicy({
    homeStateRoot,
    policy: { ...COMPLETE_POLICY },
  });
  assert.deepEqual(readStoredPtcCallbackTransportPolicy(homeStateRoot), {
    ...COMPLETE_POLICY,
  });
  assert.deepEqual(
    resolvePtcCallbackTransportPolicy({ homeStateRoot, env: {} }),
    {
      source: 'settings',
      policy: { ...COMPLETE_POLICY },
    },
  );
});

void test('the environment wins over a stored record', async (t) => {
  // 배포가 환경으로 관리되는데 저장된 레코드가 조용히 다른 한도를 적용하면 운영자가
  // 본 값과 실제 값이 갈라진다.
  const homeStateRoot = await makeHome(t);
  await writeStoredPtcCallbackTransportPolicy({
    homeStateRoot,
    policy: { ...COMPLETE_POLICY },
  });
  const resolved = resolvePtcCallbackTransportPolicy({
    homeStateRoot,
    env: {
      GEULBAT_PTC_CALLBACK_MAX_FRAME_BYTES: '4096',
      GEULBAT_PTC_CALLBACK_MAX_OPEN_CONNECTIONS: '2',
      GEULBAT_PTC_CALLBACK_MAX_CALLBACKS: '10',
      GEULBAT_PTC_CALLBACK_TIMEOUT_MS: '15000',
      GEULBAT_PTC_CALLBACK_MAX_RESPONSE_BYTES: '4096',
    },
  });
  assert.equal(resolved.source, 'environment');
  assert.equal(resolved.policy?.maxFrameBytes, 4096);
});

void test('a partial policy is refused instead of stored', async (t) => {
  const homeStateRoot = await makeHome(t);
  const { maxResponseBytes: _omitted, ...partial } = COMPLETE_POLICY;
  await assert.rejects(
    writeStoredPtcCallbackTransportPolicy({
      homeStateRoot,
      policy: partial as never,
    }),
    (error: unknown) =>
      error instanceof PtcCallbackTransportPolicyRecordError &&
      error.message.includes('maxResponseBytes'),
  );
  assert.deepEqual(
    resolvePtcCallbackTransportPolicy({ homeStateRoot, env: {} }),
    {
      source: 'disabled',
    },
  );
});

void test('a non-positive limit is refused instead of stored', async (t) => {
  const homeStateRoot = await makeHome(t);
  await assert.rejects(
    writeStoredPtcCallbackTransportPolicy({
      homeStateRoot,
      policy: { ...COMPLETE_POLICY, maxCallbacks: 0 },
    }),
    (error: unknown) =>
      error instanceof PtcCallbackTransportPolicyRecordError &&
      error.message.includes('maxCallbacks'),
  );
});

void test('a damaged record is a diagnostic, not a silent disable', async (t) => {
  // 운영자가 켠 통로가 파일 손상으로 사라지면 그건 "꺼짐"이 아니라 고쳐야 하는 상태다.
  const homeStateRoot = await makeHome(t);
  const path = ptcCallbackTransportPolicyRecordPath(homeStateRoot);
  await mkdir(join(homeStateRoot, '.geulbat'), { recursive: true });
  await writeFile(path, '{ not json', 'utf8');
  assert.throws(
    () => readStoredPtcCallbackTransportPolicy(homeStateRoot),
    PtcCallbackTransportPolicyRecordError,
  );
});

void test('an unknown schema version is refused rather than guessed', async (t) => {
  const homeStateRoot = await makeHome(t);
  const path = ptcCallbackTransportPolicyRecordPath(homeStateRoot);
  await mkdir(join(homeStateRoot, '.geulbat'), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 99, policy: COMPLETE_POLICY }),
    'utf8',
  );
  assert.throws(
    () => readStoredPtcCallbackTransportPolicy(homeStateRoot),
    (error: unknown) =>
      error instanceof PtcCallbackTransportPolicyRecordError &&
      error.message.includes('99'),
  );
});

void test('clearing the record returns the transport to disabled', async (t) => {
  const homeStateRoot = await makeHome(t);
  await writeStoredPtcCallbackTransportPolicy({
    homeStateRoot,
    policy: { ...COMPLETE_POLICY },
  });
  await clearStoredPtcCallbackTransportPolicy(homeStateRoot);
  assert.deepEqual(
    resolvePtcCallbackTransportPolicy({ homeStateRoot, env: {} }),
    {
      source: 'disabled',
    },
  );
  // 없는 레코드를 다시 지우는 것은 실패가 아니다 — 비활성 확정은 멱등이어야 한다.
  await clearStoredPtcCallbackTransportPolicy(homeStateRoot);
});

void test('the stored record keeps the schema version it was written with', async (t) => {
  const homeStateRoot = await makeHome(t);
  await writeStoredPtcCallbackTransportPolicy({
    homeStateRoot,
    policy: { ...COMPLETE_POLICY },
  });
  const raw = JSON.parse(
    await readFile(ptcCallbackTransportPolicyRecordPath(homeStateRoot), 'utf8'),
  ) as { schemaVersion: number; policy: Record<string, number> };
  assert.equal(raw.schemaVersion, 1);
  assert.deepEqual(raw.policy, { ...COMPLETE_POLICY });
});
