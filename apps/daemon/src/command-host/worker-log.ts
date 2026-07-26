import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// P7.5 spec v4 §9.3 — 워커 stdio는 ignore다. 데몬이 죽어도 살아남는
// 프로세스가 흔적을 하나도 남기지 않으면 사후 진단이 불가능하므로, 워커는
// 자기 **수명 사건만** 파일에 남긴다. 세션에 무슨 일이 있었는지는 저널이
// 답하고(§5.1) 이 로그는 "워커에게 무슨 일이 있었는지"만 답한다 — 명령
// 단위 기록을 여기 넣으면 유계성도 잃고 저널과 진실이 갈라진다.
//
// 기록은 **동기**다. 크래시 직전의 마지막 한 줄이 반드시 떨어져야 하는데
// 비동기 쓰기는 process.exit를 이기지 못한다. 수명 사건은 워커 일생에
// 수십 줄이라 동기 비용이 문제되지 않는다.

/**
 * 세대당 상한. 회전은 직전 세대 하나만 남기므로 총 사용량은 2세대로
 * 유계다 — §9.3이 로그 파일에 요구하는 rotation 상한이 이것이다.
 */
export const WORKER_LOG_MAX_BYTES = 256 * 1024;

export function buildCommandHostWorkerLogPath(stateRoot: string): string {
  return join(stateRoot, '.geulbat', 'command-host', 'worker.log');
}

type WorkerLogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface WorkerLog {
  write(event: string, fields?: WorkerLogFields): void;
  /** 진단용 — 현재 세대에 기록된 바이트. */
  bytesWritten(): number;
}

export function openWorkerLog(args: {
  path: string;
  workerInstanceId: string;
}): WorkerLog {
  try {
    mkdirSync(dirname(args.path), { recursive: true, mode: 0o700 });
  } catch {
    // 디렉터리를 못 만들어도 워커는 계속 산다 — 아래 write가 조용히 실패한다.
  }
  let bytes = currentSize(args.path);

  return {
    write(event, fields) {
      const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        workerInstanceId: args.workerInstanceId,
        event,
        ...omitUndefined(fields),
      })}\n`;
      const size = Buffer.byteLength(line);
      try {
        if (bytes + size > WORKER_LOG_MAX_BYTES) {
          renameSync(args.path, `${args.path}.1`);
          bytes = 0;
        }
        appendFileSync(args.path, line, { mode: 0o600 });
        bytes += size;
      } catch {
        // 진단이 운영을 죽여서는 안 된다. 로그 실패는 로그 실패로 끝난다.
      }
    },
    bytesWritten() {
      return bytes;
    },
  };
}

function currentSize(path: string): number {
  try {
    // 정규 파일일 때만 "현재 세대"가 존재한다. 그 자리에 디렉터리 같은 다른
    // 것이 있으면 크기를 물려받아 회전 계산을 어긋나게 해서는 안 된다.
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

function omitUndefined(fields: WorkerLogFields | undefined): WorkerLogFields {
  if (fields === undefined) {
    return {};
  }
  const kept: WorkerLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      kept[key] = value;
    }
  }
  return kept;
}
