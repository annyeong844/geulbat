import test from 'node:test';
import assert from 'node:assert/strict';

import { runComputerBrowseDiscoveryLoop } from './computer-browse-discovery.js';
import type { ComputerFileScope } from './computer-file-scope.js';

function buildScope(): ComputerFileScope {
  return {
    root: '/',
    browseStartPath: '/mnt/c/Workspace',
    browseShortcuts: [
      { label: 'Ubuntu (WSL)', path: '/' },
      { label: 'Windows (C:)', path: '/mnt/c' },
    ],
  };
}

void test('discovery loop retries a failed attempt and converges in place', async () => {
  // 회귀 잠금(2026-07-23): 명령 기반 발견의 1회 실패가 데몬 수명 동안
  // 동결되어 빠른 위치에서 다운로드·사진·음악이 사라지던 버그. 실패는
  // 재시도되어야 하고, 성공 결과는 같은 스코프 객체에 반영되어야 한다.
  const scope = buildScope();
  const waits: number[] = [];
  let attempts = 0;
  await runComputerBrowseDiscoveryLoop({
    scope,
    discover: () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error('powershell interop hiccup'));
      }
      return Promise.resolve({
        browseShortcuts: [
          { label: '다운로드', path: '/mnt/c/Workspace/Downloads' },
          { label: '사진', path: '/mnt/c/Workspace/사진' },
          { label: 'Ubuntu (WSL)', path: '/' },
          { label: 'Windows (C:)', path: '/mnt/c' },
        ],
        complete: true,
      });
    },
    wait: (delayMs) => {
      waits.push(delayMs);
      return Promise.resolve();
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [5_000]);
  assert.deepEqual(
    scope.browseShortcuts.map((shortcut) => shortcut.label),
    ['다운로드', '사진', 'Ubuntu (WSL)', 'Windows (C:)'],
  );
});

void test('discovery loop applies partial results but keeps retrying until complete', async () => {
  const scope = buildScope();
  const seenAfterPartial: string[][] = [];
  let attempts = 0;
  await runComputerBrowseDiscoveryLoop({
    scope,
    discover: () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({
          browseShortcuts: [{ label: 'Windows (C:)', path: '/mnt/c' }],
          complete: false,
        });
      }
      return Promise.resolve({
        browseShortcuts: [
          { label: 'Downloads', path: '/mnt/c/Workspace/Downloads' },
          { label: 'Windows (C:)', path: '/mnt/c' },
        ],
        complete: true,
      });
    },
    wait: () => {
      seenAfterPartial.push(scope.browseShortcuts.map((s) => s.label));
      return Promise.resolve();
    },
  });

  assert.equal(attempts, 2);
  // 부분 결과도 즉시 반영되고(재시도 대기 시점에 이미 교체됨), 완성되면
  // 전체 교체된다 — 부분 성공이 섞여 쌓이지 않는다.
  assert.deepEqual(seenAfterPartial, [['Windows (C:)']]);
  assert.deepEqual(
    scope.browseShortcuts.map((shortcut) => shortcut.label),
    ['Downloads', 'Windows (C:)'],
  );
});

void test('discovery loop stops at the attempt bound without freezing garbage', async () => {
  const scope = buildScope();
  let attempts = 0;
  await runComputerBrowseDiscoveryLoop({
    scope,
    discover: () => {
      attempts += 1;
      return Promise.reject(new Error('interop permanently unavailable'));
    },
    maxAttempts: 3,
    wait: () => Promise.resolve(),
  });

  assert.equal(attempts, 3);
  // 발견이 끝내 실패해도 부팅 때의 명령-불요 위치는 그대로 산다
  assert.deepEqual(
    scope.browseShortcuts.map((shortcut) => shortcut.label),
    ['Ubuntu (WSL)', 'Windows (C:)'],
  );
});
