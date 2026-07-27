import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * 기본 브라우저로 주소를 연다.
 *
 * 플랫폼마다 명령이 다르고 그 목록이 이 함수의 전부다. 실패를 삼키지 않는다:
 * 브라우저가 열리지 않았다는 사실은 호출부가 알아야 하고, 사용자는 최소한
 * 주소를 직접 열 수 있어야 한다.
 */
export async function openUrlInBrowser(
  url: string,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  const { command, args } = resolveOpenCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      stdio: 'ignore',
      // 브라우저는 이 프로세스보다 오래 살아야 한다. 데몬이 종료될 때 열린 창을
      // 함께 닫으면 안 된다.
      detached: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function resolveOpenCommand(url: string): {
  command: string;
  args: readonly string[];
} {
  switch (platform()) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // `start`는 cmd 내장이라 셸을 거쳐야 한다. 첫 인자는 창 제목 자리이므로
      // 빈 문자열을 넣어 URL이 제목으로 먹히지 않게 한다.
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}
