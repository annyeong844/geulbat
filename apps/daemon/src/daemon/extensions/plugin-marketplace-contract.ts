// Plugin marketplace 계약 leaf — 에러/코드, git acquirer 시그니처, 플러그인
// 이름 패턴, 그리고 marketplace 모듈들이 공유하는 최소 가드/진단 셰이퍼.
// store·catalog·git·fs 모두 이 leaf만 내려다본다 (re-export 없이 소비자가
// 직접 import).
import { PluginPackageAdmissionError } from './plugin-package-admission-contract.js';

export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type PluginMarketplaceStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'corrupt_registry';

export class PluginMarketplaceStoreError extends Error {
  constructor(
    readonly code: PluginMarketplaceStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginMarketplaceStoreError';
  }
}

export type PluginMarketplaceGitAcquirer = (args: {
  repositoryRoot: string;
  url: string;
  requestedRef: string | null;
  isolatedConfigRoot: string;
}) => Promise<void>;

export function safeDiagnosticMessage(message: string, error: unknown): string {
  return error instanceof PluginPackageAdmissionError ||
    error instanceof PluginMarketplaceStoreError
    ? `${message}: ${error.message}`
    : message;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
