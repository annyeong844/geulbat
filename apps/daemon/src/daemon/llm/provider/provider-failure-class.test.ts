import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_FAILURE_CLASSES,
  STREAM_ERROR_CATEGORY_VALUES,
  findProviderFailureClassByProviderCode,
  resolveProviderFailureClass,
} from './provider-failure-class.js';

// switch 문을 표로 합치면서 컴파일러의 exhaustiveness 검사가 사라졌다.
// 카테고리가 표에서 빠지면 조회가 런타임에 던지므로, 그 보장을 테스트가 잇는다.
void test('every failure class category resolves to exactly one row', () => {
  for (const category of STREAM_ERROR_CATEGORY_VALUES) {
    const failureClass = resolveProviderFailureClass(category);
    assert.equal(failureClass.category, category);
  }

  const categories = PROVIDER_FAILURE_CLASSES.map(
    (failureClass) => failureClass.category,
  );
  assert.equal(
    new Set(categories).size,
    categories.length,
    'a duplicated category row would make lookups order-dependent',
  );
});

void test('no provider code is claimed by two failure classes', () => {
  const owners = new Map<string, string>();
  for (const failureClass of PROVIDER_FAILURE_CLASSES) {
    for (const providerCode of failureClass.providerCodes) {
      const existing = owners.get(providerCode);
      assert.equal(
        existing,
        undefined,
        `provider code ${providerCode} is claimed by both ${String(existing)} and ${failureClass.category}`,
      );
      owners.set(providerCode, failureClass.category);
    }
  }
});

void test('provider code lookup routes each registered code to its own class', () => {
  for (const failureClass of PROVIDER_FAILURE_CLASSES) {
    for (const providerCode of failureClass.providerCodes) {
      assert.equal(
        findProviderFailureClassByProviderCode(providerCode)?.category,
        failureClass.category,
      );
    }
  }
  assert.equal(
    findProviderFailureClassByProviderCode('not_a_provider_code'),
    undefined,
  );
});

// 와이어 코드가 비어 있으면 실패가 실제 오류에서 끌어온 코드로 나간다.
// 분류에 성공한 클래스가 그 경로를 타면 사용자에게 나가는 코드가 조용히
// 달라지므로, 비어 있어도 되는 클래스는 분류 실패 하나뿐이다.
void test('only the unknown class leaves its wire code to the observed error', () => {
  for (const failureClass of PROVIDER_FAILURE_CLASSES) {
    if (failureClass.category === 'unknown') {
      assert.equal(failureClass.wireCode, null);
      continue;
    }
    assert.notEqual(
      failureClass.wireCode,
      null,
      `${failureClass.category} must declare the code the user sees`,
    );
  }
});

void test('outcome-unknown provider requests preserve their user-recoverable wire code without retrying', () => {
  const failureClass = resolveProviderFailureClass(
    'llm_provider_request_outcome_unknown',
  );
  assert.equal(failureClass.wireCode, 'llm_provider_request_outcome_unknown');
  assert.equal(failureClass.retryBudget, null);
});

// 인증서 검증 실패는 결정적이므로 이 목록에 들어오면 안 된다. 들어오면 같은
// handshake 실패를 재시도로 태우고 "timed out"이라는 틀린 진단이 나간다.
void test('retry budgets are only claimed by classes a retry can resolve', () => {
  const retryable = PROVIDER_FAILURE_CLASSES.filter(
    (failureClass) => failureClass.retryBudget !== null,
  ).map((failureClass) => failureClass.category);

  assert.deepEqual(retryable, [
    'llm_idle_timeout',
    'llm_connection_lost',
    'llm_overloaded',
    'llm_rate_limited',
  ]);
});
