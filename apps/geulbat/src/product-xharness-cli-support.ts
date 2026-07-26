/**
 * xharness CLI 레인 공용 검증·입출력 도우미.
 *
 * 이 레인의 파일들은 기능을 하나씩 늘리면서 필요한 도우미를 함께 복제해 왔고,
 * 복제본이 표류했다(2026-07-25 측정: isErrorCode 7곳 3종, assertExactPlainRecord
 * 5곳 2종). 이름과 목적이 같은데 동작이 다른 검증기는 단순 중복보다 위험해서
 * 하나로 모은다.
 *
 * 정본 선택 기준은 "합치면서 어느 쪽으로도 느슨해지지 않을 것"이다:
 * - plain object 판정은 좁은 쪽(Object.prototype 전용)을 택했다. 이 레인의
 *   입력은 전부 JSON.parse 산출물이라 널 프로토타입이 나올 수 없어, 넓은 쪽을
 *   택하면 검증만 약해지고 얻는 게 없다.
 * - errno 판정은 넓은 쪽(instanceof Error 불요)을 택했다. 레인 다수(4/7)이자
 *   daemon utils의 getErrorCode와 같은 관례다.
 */
import { readFile } from 'node:fs/promises';

/**
 * JSON.parse가 만들어내는 순수 객체만 통과시킨다. 배열·클래스 인스턴스·널
 * 프로토타입 객체는 모두 거부한다.
 */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function assertPlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

/**
 * 선언한 키와 정확히 일치하는 순수 객체만 통과시킨다 — 모르는 필드를 조용히
 * 흘려보내면 계약 밖 데이터가 산출물로 굳는다.
 */
export function assertExactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = assertPlainRecord(value, label);
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

/** errno 계열 오류의 code 판정 (ENOENT 등). */
export function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code
  );
}

/**
 * 필수 JSON 산출물 읽기 — 파일이 없을 때만 호출자가 준 안내 문구로 바꾸고,
 * 나머지 오류(권한·손상된 JSON)는 그대로 올린다.
 */
export async function readRequiredJson(
  filePath: string,
  unavailableMessage: string,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      throw new Error(unavailableMessage);
    }
    throw error;
  }
}

export type Sha256Digest = `sha256:${string}`;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]+$/u;

/**
 * 공백만 있는 문자열도 거부한다. 두 소스 레인이 trim 여부로 갈려 있었고
 * (2026-07-25), 좁은 쪽을 정본으로 삼는다 — 산출물 식별자에 공백-only가
 * 들어갈 이유가 없다.
 */
export function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function readDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value as Sha256Digest;
}

export function readObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !GIT_OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase hexadecimal Git object id`);
  }
  return value;
}

/**
 * 경로 탈출 차단 — 절대 경로·역참조·백슬래시·NUL을 모두 거부한다. 두 소스
 * 레인에 같은 본문이 복제돼 있었다. 보안 판정은 한 곳에서만 강화한다.
 */
export function readRepositoryRelativePath(
  value: unknown,
  label: string,
): string {
  const candidate = readNonEmptyString(value, label);
  if (
    candidate.includes('\0') ||
    candidate.includes('\\') ||
    candidate.startsWith('/') ||
    candidate === '.' ||
    candidate === '..' ||
    candidate.startsWith('../') ||
    candidate.includes('/../') ||
    candidate.endsWith('/..') ||
    candidate.startsWith('./') ||
    candidate.includes('/./') ||
    candidate.endsWith('/.')
  ) {
    throw new Error(`${label} must be a canonical repository-relative path`);
  }
  return candidate;
}
