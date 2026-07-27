import {
  DEV_TOKEN_HEADER_NAME,
  SHELL_ACCESS_TOKEN_META_NAME,
} from '@geulbat/protocol/shell-auth';
import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';

export { DEV_TOKEN_HEADER_NAME };

/**
 * 이 모듈이 문서에서 쓰는 것은 meta 하나를 찾아 content를 읽는 일뿐이다. 필요한
 * 만큼만 요구하면 `Document`가 그대로 들어맞으면서, 대역도 캐스트 없이 실제 값
 * 으로 만들 수 있다.
 */
interface ShellAccessTokenDocument {
  querySelector(selectors: string): {
    getAttribute(name: string): string | null;
  } | null;
}

/**
 * 접속 토큰의 출처는 데몬이 서빙한 진입 문서다. 사용자가 입력하지 않고 번들에
 * 박히지도 않는다 — 값은 요청 시점에 문서로 전달된다.
 *
 * 두 부재를 구별한다. **문서 자체가 없으면** 브라우저가 아니다(Node 테스트,
 * 도구): 토큰이 있을 자리가 없으므로 `undefined`다. **문서가 있는데 토큰이
 * 없으면** 데몬이 서빙하지 않은 문서이므로 설정 오류다: 그럴듯한 대체값으로
 * 덮지 않고 실패로 드러낸다. 인증되지 않은 화면이 조용히 반쯤 동작하면 원인을
 * 찾기 어렵다.
 */
export function readShellAccessTokenFromDocument(
  documentRef: ShellAccessTokenDocument | undefined = globalThis.document,
): string | undefined {
  if (documentRef === undefined) {
    return undefined;
  }

  const meta = documentRef.querySelector(
    `meta[name="${SHELL_ACCESS_TOKEN_META_NAME}"]`,
  );
  const token = meta?.getAttribute('content')?.trim();
  if (token === undefined || token === '') {
    throw new Error(
      `the served document is missing ${SHELL_ACCESS_TOKEN_META_NAME}; the daemon must serve the shell`,
    );
  }
  return token;
}

export function buildShellAuthHeaders(
  token: string | undefined = readShellAccessTokenFromDocument(),
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token === undefined ? {} : { [DEV_TOKEN_HEADER_NAME]: token }),
  };
}

/**
 * HTTP 헤더와 달리 `run.auth` 프레임은 자격증명 그 자체다. 토큰이 없으면 보낼
 * 것이 없으므로 빈 문자열로 채우지 않는다 — 그것은 데몬이 "인증을 시도했고
 * 틀렸다"로 읽는 값이고, 실제 원인(문서에 토큰이 없다)을 가린다.
 */
export function buildRunChannelAuthMessage(
  requestId: string,
  token: string | undefined = readShellAccessTokenFromDocument(),
): RunChannelClientMessage {
  if (token === undefined) {
    throw new Error(
      'cannot authenticate the run channel without a shell access token',
    );
  }

  return {
    type: 'run.auth',
    requestId,
    token,
  };
}
