import {
  getErrorCode,
  getErrorNumberProperty,
  getErrorStringProperty,
} from '../../../utils/error.js';

/**
 * Node가 인증서 검증 실패를 구조화된 error code로 준다. `ws`의 error 이벤트는
 * 이 코드를 그대로 넘겨주므로(로컬 확인: 자가서명 인증서 →
 * `DEPTH_ZERO_SELF_SIGNED_CERT`), 메시지 부분매칭 없이 코드로만 판정한다.
 *
 * 전송 중 TLS alert(`bad record mac` 등)은 여기 넣지 않는다. 그건 일시적
 * 장애라 재시도 가능한 연결 유실로 남아야 한다.
 */
const TLS_CERTIFICATE_VERIFICATION_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function createWebSocketConnectionError(message: string): Error {
  return Object.assign(new Error(message), {
    llmCode: 'llm_connection_lost' as const,
  });
}

function createTlsVerificationError(message: string): Error {
  return Object.assign(new Error(message), {
    llmCode: 'llm_tls_verification_failed' as const,
  });
}

function createWebSocketError(message: string): Error {
  const status =
    message === 'Unexpected server response: 401'
      ? 401
      : message === 'Unexpected server response: 403'
        ? 403
        : undefined;
  if (status === undefined) {
    return createWebSocketConnectionError(message);
  }
  return Object.assign(new Error(message), {
    status,
    llmCode: 'llm_auth_failed' as const,
  });
}

export function extractWebSocketError(event: unknown): Error {
  const errorCode = getErrorCode(event);
  if (
    errorCode !== undefined &&
    TLS_CERTIFICATE_VERIFICATION_ERROR_CODES.has(errorCode)
  ) {
    // Node의 원문 메시지는 진단에 필요한 정보를 담고 있어 그대로 보존한다.
    // 사용자에게 나가는 문장은 실패 클래스 owner 표가 정한다.
    return createTlsVerificationError(
      getErrorStringProperty(event, 'message') ??
        'TLS certificate verification failed',
    );
  }
  if (event instanceof Error && event.message) {
    return createWebSocketError(event.message);
  }
  if (event && typeof event === 'object' && 'message' in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return createWebSocketError(message);
    }
  }
  return createWebSocketConnectionError('WebSocket error');
}

export function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === 'object') {
    const code = getErrorNumberProperty(event, 'code');
    const reason: unknown =
      getErrorStringProperty(event, 'reason') ?? Reflect.get(event, 'reason');
    const codeText = typeof code === 'number' ? ` ${code}` : '';
    const reasonText =
      typeof reason === 'string'
        ? reason.length > 0
          ? ` ${reason}`
          : ''
        : reason instanceof Uint8Array
          ? ` ${new TextDecoder().decode(reason)}`
          : '';
    return createWebSocketConnectionError(
      `WebSocket closed${codeText}${reasonText}`.trim(),
    );
  }
  return createWebSocketConnectionError('WebSocket closed');
}
