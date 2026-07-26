import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createLogger, type Logger } from '@geulbat/structured-logger/logger';
import { currentActivity, type DaemonActivity } from './activity-scope.js';
import { getErrorMessage } from './error.js';

// 치명적 종료는 fail-closed로 둔다 — 예외를 삼켜 프로세스를 살려두지 않는다.
// 대신 **누구 때문에 죽었는지**를 남긴다. 그 답이 없으면 "데몬이 죽었다"만
// 남고 "PTC 셀 하나가 데몬을 죽였다"는 영영 알 수 없다.

export type DaemonFatalKind = 'uncaught_exception' | 'unhandled_rejection';

export interface DaemonFatalRecord {
  when: string;
  kind: DaemonFatalKind;
  pid: number;
  message: string;
  stack: string | undefined;
  origin: string | undefined;
  /**
   * 활동 스코프가 비어 있으면 `null`이다 — 그때의 죽음은 남의 실패가 아니라
   * 데몬 자신의 이유다. 이 구별이 이 기록의 존재 이유다.
   */
  owner: DaemonActivity | null;
}

interface ProcessFatalTarget {
  on(
    event: 'uncaughtExceptionMonitor',
    listener: (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void,
  ): void;
  on(
    event: 'uncaughtException',
    listener: (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void,
  ): void;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}

const defaultLogger = createLogger('process');

export function registerProcessFatalLogging(args: {
  /**
   * 기록을 둘 곳. 기본값을 두지 않는 이유는, 경로를 아는 것은 프로세스를
   * 조립하는 쪽이고 이 모듈은 쓰기만 하기 때문이다 — 기본값을 두면 배선을
   * 빠뜨려도 기록이 조용히 사라진다.
   */
  recordPath: () => string;
  process?: ProcessFatalTarget;
  logger?: Pick<Logger, 'error'>;
  now?: () => Date;
  pid?: () => number;
  exit?: (code: number) => void;
}): void {
  const target = args.process ?? process;
  const fatalLogger = args.logger ?? defaultLogger;
  const resolveRecordPath = args.recordPath;
  const now = args.now ?? (() => new Date());
  const readPid = args.pid ?? (() => process.pid);
  const exit = args.exit ?? ((code: number) => process.exit(code));

  const fail = (
    kind: DaemonFatalKind,
    error: unknown,
    origin: NodeJS.UncaughtExceptionOrigin | undefined,
  ): void => {
    const record: DaemonFatalRecord = {
      when: now().toISOString(),
      kind,
      pid: readPid(),
      message: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
      origin,
      owner: currentActivity() ?? null,
    };
    fatalLogger.error('fatal:', {
      kind: record.kind,
      message: record.message,
      ...(record.origin === undefined ? {} : { origin: record.origin }),
      // 소유자 없는 죽음은 데몬 자신의 불변식이 깨진 것이다.
      owner: record.owner ?? 'daemon',
      ...(record.stack === undefined ? {} : { stack: record.stack }),
    });
    // 기록에 실패해도 죽는 것을 막지 않는다 — 기록은 진단이고 종료가 계약이다.
    try {
      writeFatalRecord(resolveRecordPath(), record);
    } catch (writeError: unknown) {
      fatalLogger.error('fatal record could not be written:', {
        message: getErrorMessage(writeError),
      });
    }
    exit(1);
  };

  target.on('uncaughtExceptionMonitor', (error, origin) => {
    fatalLogger.error('uncaught exception:', {
      message: getErrorMessage(error),
      origin,
    });
  });
  target.on('uncaughtException', (error, origin) => {
    fail('uncaught_exception', error, origin);
  });
  target.on('unhandledRejection', (reason) => {
    fail('unhandled_rejection', reason, undefined);
  });
}

/**
 * 죽는 중에는 동기 쓰기만 완결을 보장한다 — 비동기 쓰기는 프로세스가 먼저
 * 사라져 아무 것도 남기지 못한다.
 */
function writeFatalRecord(path: string, record: DaemonFatalRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}
