import assert from 'node:assert/strict';
import test from 'node:test';

import { describeCommandHostMemoryBudget } from './memory-budget.js';

const MIB = 1024 * 1024;

void test('§4.1: the output ring budget is the stated 128MiB hard cap', () => {
  const budget = describeCommandHostMemoryBudget();
  // 64 세션 × 2 스트림 × 1MiB — 스펙이 이름으로 부르는 숫자다.
  assert.equal(budget.outputRingBytes, 128 * MIB);
});

void test('§4.1: the total is the sum of independently enforced terms', () => {
  const budget = describeCommandHostMemoryBudget();
  const summed = budget.terms.reduce(
    (total, term) => total + term.totalBytes,
    0,
  );
  assert.equal(budget.totalBytes, summed);
  assert.equal(
    budget.totalBytes,
    budget.outputRingBytes + budget.transportBytes,
  );
  for (const term of budget.terms) {
    assert.equal(
      term.totalBytes,
      term.perUnitBytes * term.units,
      `${term.label} must be a product of its own limit and unit count`,
    );
    assert.ok(
      term.enforcedBy.length > 0,
      `${term.label} must name the code that enforces it — an unenforced term is not a budget`,
    );
  }
});

void test('§4.1: transport budget exceeds the ring budget', () => {
  const budget = describeCommandHostMemoryBudget();
  // 3차 정밀화가 경고한 그대로다: 128MiB는 링만의 상한이고 §7.5 예산이
  // 그 위에 더해진다. 이 관계가 뒤집히면 어느 한쪽 상한이 조용히 바뀐 것이다.
  assert.ok(
    budget.transportBytes > budget.outputRingBytes,
    `transport ${budget.transportBytes} vs rings ${budget.outputRingBytes}`,
  );
});

void test('§4.1: the worst-case worker footprint is pinned', () => {
  // 회귀 트립와이어다 — 목표치가 아니라 "상한을 바꿨으면 의식하고 바꿔라"는
  // 장치다. 이 값이 흔들리면 §7.5나 §4.4의 상한이 움직였다는 뜻이다.
  const budget = describeCommandHostMemoryBudget();
  assert.equal(budget.totalBytes, 308 * MIB);
});

void test('a smaller ring configuration shrinks only the ring term', () => {
  const base = describeCommandHostMemoryBudget();
  const small = describeCommandHostMemoryBudget({ tailRingBytes: 64 * 1024 });
  assert.equal(small.outputRingBytes, 64 * 1024 * 64 * 2);
  assert.equal(small.transportBytes, base.transportBytes);
  assert.ok(small.totalBytes < base.totalBytes);
});
