export type PublicHttpReadFailureReason =
  | 'aborted'
  | 'dns_blocked'
  | 'host_unavailable'
  | 'invalid_request'
  | 'invalid_response'
  | 'network_error'
  | 'response_too_large'
  | 'timeout';

export interface PublicHttpReadInvocation {
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  headers: Record<string, string>;
  bodyBase64?: string;
  responseBodyMode: 'full' | 'discard';
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export type PublicHttpReadOutcome =
  | {
      ok: true;
      status: number;
      location: string | null;
      contentType: string | null;
      contentLength: number | null;
      bodyBase64: string;
    }
  | {
      ok: false;
      reasonCode: PublicHttpReadFailureReason;
      message: string;
    };

export interface PublicHttpReadRuntime {
  request(
    args: PublicHttpReadInvocation & {
      signal?: AbortSignal;
    },
  ): Promise<PublicHttpReadOutcome>;
}
