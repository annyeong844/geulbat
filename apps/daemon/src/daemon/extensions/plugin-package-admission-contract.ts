// Plugin package admission 계약 leaf — 클러스터 최심부. admission 에러와
// 최소 가드를 소유하고, plugin-store·marketplace 계열이 직접 import한다
// (re-export 금지 정책). 이 모듈은 형제를 일절 import하지 않는다.

import { isPluginRecord as isRecord } from './plugin-value-guards.js';

export class PluginPackageAdmissionError extends Error {
  constructor(
    readonly code: 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'PluginPackageAdmissionError';
  }
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertNoEmbeddedCredentials(
  root: Record<string, unknown>,
  displayPath: string,
  options: {
    rootKeysAreComponentIdentities?: boolean;
    rootComponentIdentityFields?: readonly string[];
  } = {},
): void {
  const rootComponentIdentityFields = new Set(
    options.rootComponentIdentityFields ?? [],
  );
  const pending: Array<{
    value: Record<string, unknown> | unknown[];
    keysAreComponentIdentities: boolean;
  }> = [
    {
      value: root,
      keysAreComponentIdentities:
        options.rootKeysAreComponentIdentities === true,
    },
  ];
  while (pending.length > 0) {
    const { value, keysAreComponentIdentities } = pending.pop()!;
    for (const [key, child] of Object.entries(value)) {
      if (
        !keysAreComponentIdentities &&
        isCredentialValueKey(key) &&
        !isCredentialReferenceKey(key)
      ) {
        throw new PluginPackageAdmissionError(
          'invalid_request',
          `plugin configuration contains an inline credential field: ${displayPath}`,
        );
      }
      if (Array.isArray(child) || isRecord(child)) {
        pending.push({
          value: child,
          keysAreComponentIdentities:
            !keysAreComponentIdentities &&
            value === root &&
            rootComponentIdentityFields.has(key),
        });
      }
    }
  }
}

function isCredentialValueKey(key: string): boolean {
  return /(?:secret|password|passphrase|token|api[_-]?key|credential|private[_-]?key|authorization|cookie)/iu.test(
    key,
  );
}

function isCredentialReferenceKey(key: string): boolean {
  return /(?:env(?:ironment)?[_-]?(?:var|key)|[_-](?:ref|reference|name)|envKeys$)/iu.test(
    key,
  );
}
