import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { hasErrorCode } from '../utils/error.js';

/**
 * web shell이 이 데몬에 접속할 때 쓰는 로컬 공유 비밀.
 *
 * 사용자가 정하는 값이 아니다. 비밀번호가 아니라 데몬과 그 데몬이 서빙하는
 * 화면 사이의 일회성 자격이며, 데몬이 스스로 만들어 보관한다. 사용자가 값을
 * 입력해야 하면 설치가 한 번에 끝나지 않는다.
 *
 * loopback 바인딩만으로 충분하지 않은 이유: 사용자가 방문한 임의의 웹페이지가
 * `http://127.0.0.1:<port>`로 요청을 보낼 수 있고, WebSocket에는 CORS가 없어서
 * 브라우저가 그 연결을 막지 않는다. 이 토큰이 그 경계를 지킨다.
 */
/** §토큰 강도 — 32바이트 hex. 사람이 외우거나 입력할 값이 아니다. */
const SHELL_ACCESS_TOKEN_BYTES = 32;

const MIN_SHELL_ACCESS_TOKEN_LENGTH = 16;

/**
 * 이 Geulbat Home의 토큰. 없으면 만든다.
 *
 * 우선순위는 명시적 환경값 → 저장된 파일 → 새로 생성이다. 환경값이 먼저인
 * 이유: 운영자가 프로세스 관리자나 배포 플랫폼에서 주입한 값이 파일보다
 * 최신 의도다.
 */
export function ensureShellAccessToken(args: {
  /** 토큰 파일의 절대 경로. 경로 구성은 state root 소유자의 일이다. */
  tokenPath: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const configured = readConfiguredShellAccessToken(args.env ?? process.env);
  if (configured !== undefined) {
    return configured;
  }

  const stored = readStoredShellAccessToken(args.tokenPath);
  if (stored !== undefined) {
    return stored;
  }

  const generated = randomBytes(SHELL_ACCESS_TOKEN_BYTES).toString('hex');
  try {
    mkdirSync(dirname(args.tokenPath), { recursive: true, mode: 0o700 });
    // `wx`는 이미 있으면 실패한다. 동시에 두 데몬이 만들려 할 때 한쪽만
    // 쓰고 다른 쪽은 아래에서 이미 쓰인 값을 읽는다.
    writeFileSync(args.tokenPath, `${generated}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return generated;
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
    const raced = readStoredShellAccessToken(args.tokenPath);
    if (raced === undefined) {
      throw new Error(`shell access token file is unusable: ${args.tokenPath}`);
    }
    return raced;
  }
}

function readConfiguredShellAccessToken(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw = env['GEULBAT_DEV_TOKEN'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return undefined;
  }
  assertUsableShellAccessToken(raw, 'GEULBAT_DEV_TOKEN');
  return raw;
}

function readStoredShellAccessToken(tokenPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(tokenPath, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }

  const token = raw.trim();
  if (token === '') {
    return undefined;
  }
  assertUsableShellAccessToken(token, `shell access token file ${tokenPath}`);
  return token;
}

/**
 * 짧은 토큰은 조용히 받아들이지 않는다. 값 자체는 진단에 싣지 않는다 — 비밀을
 * 로그나 오류 메시지로 흘리지 않기 위해 출처만 말한다.
 */
function assertUsableShellAccessToken(token: string, source: string): void {
  if (token.length < MIN_SHELL_ACCESS_TOKEN_LENGTH) {
    throw new Error(
      `${source} must be at least ${MIN_SHELL_ACCESS_TOKEN_LENGTH} characters`,
    );
  }
}
