import type { PtcLabBrowserEvidenceDiagnostics } from './browser-evidence-contract.js';

export const PTC_BROWSER_RUNTIME_MAX_URL_BYTES = 2048;
export const PTC_BROWSER_RUNTIME_MAX_TIMEOUT_MS = 15_000;

export interface PtcBrowserRuntimeUrlRequest {
  url: string;
  timeoutMs?: number;
}

interface PtcBrowserRuntimeRunContext {
  threadId: string;
  workspaceRoot: string;
}

export interface PtcBrowserRuntimeOperationArgs<Request> {
  runContext: PtcBrowserRuntimeRunContext;
  request: Request;
  signal?: AbortSignal;
}

export interface PtcBrowserRuntimeCloseAllArgs {
  signal?: AbortSignal;
}

export type PtcBrowserRuntimeCleanupResult<ReasonCode extends string> =
  | { ok: true }
  | {
      ok: false;
      reasonCode: ReasonCode;
      message: string;
      diagnostics?: PtcLabBrowserEvidenceDiagnostics;
    };
