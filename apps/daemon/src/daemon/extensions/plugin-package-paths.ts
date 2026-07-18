// Plugin package 경로 봉쇄(containment) — 패키지 루트 밖으로 나가는 선언
// 경로(절대경로·드라이브 문자·..·널바이트)를 거부/무효화하고, 검증된
// 상대경로를 패키지 절대경로로 사상하는 순수 계층. admission 검사와 MCP
// 런타임 경로 정규화가 공유한다.
import { isAbsolute, join, posix, win32 } from 'node:path';

import { PluginPackageAdmissionError } from './plugin-package-admission-contract.js';

export function normalizeDeclaredPackagePath(
  value: string,
  field: string,
): string {
  if (
    value.includes('\0') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest component path is not contained: ${field}`,
    );
  }
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest component path is not contained: ${field}`,
    );
  }
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized === '' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest component path is not contained: ${field}`,
    );
  }
  return normalized.replace(/^\.\//u, '').replace(/\/+$/u, '');
}

export function normalizeContainedRuntimePath(value: string): string | null {
  if (value.includes('\0') || isNonPortableAbsolutePath(value)) {
    return null;
  }
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized.replace(/^\.\//u, '').replace(/\/+$/u, '') || '.';
}

export function isNonPortableAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)
  );
}

export function isPathWithin(
  relativePath: string,
  directoryPath: string,
): boolean {
  return (
    relativePath === directoryPath ||
    relativePath.startsWith(`${directoryPath}/`)
  );
}

export function toAbsolutePackagePath(
  root: string,
  relativePath: string,
): string {
  return relativePath === '' ? root : join(root, ...relativePath.split('/'));
}
