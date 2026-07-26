import assert from 'node:assert/strict';

/**
 * 계약 필드가 "선언만 되고 검사는 안 되는" 상태를 구조적으로 막는 도구.
 *
 * 오염값 맵의 키가 가드가 좁히는 타입에 묶여 있어, 계약에 필드를 늘리면 여기
 * 항목을 채울 때까지 컴파일이 깨진다. 그리고 각 오염값이 정말 거부되는지까지
 * 확인하므로, 항목만 채우고 가드를 안 고치면 이번엔 테스트가 깨진다.
 *
 * 실제로 이 감사 방식이 threads.ts의 isThreadSummary가 pinned를 검사하지 않는
 * 누락을 찾아냈다(2026-07-25).
 */
type FieldRejections<T> = { readonly [K in keyof T]-?: unknown };

export function assertEveryFieldIsValidated<T extends object>(
  label: string,
  guard: (value: unknown) => value is T,
  valid: T,
  rejections: FieldRejections<T>,
): void {
  assert.equal(guard(valid), true, `${label}: 정상 값이 거부됐다`);
  for (const [field, rejected] of Object.entries(rejections)) {
    assert.equal(
      guard({ ...valid, [field]: rejected }),
      false,
      `${label}.${field}: 가드가 이 필드를 검사하지 않는다`,
    );
  }
}
