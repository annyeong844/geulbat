import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import {
  isProcessAlive,
  readCommandHostLock,
  resolveCommandHostPaths,
} from '../command-host/runtime-paths.js';

// P7.5 — 워커 배치의 teardown 규칙 하나를 한 곳에 둔다.
//
// 워커는 자기를 띄운 프로세스보다 오래 산다(그것이 이 계층의 존재 이유다).
// 그래서 테스트가 stateRoot를 그냥 지우면, 워커가 저널·로그·산출물을 쓰는
// 도중에 디렉터리가 사라져 `ENOTEMPTY`로 터진다 — 실제로 세 번 났다.
// 순서는 하나뿐이다: **워커를 세우고, 나갈 때까지 기다린 다음, 지운다.**

const WORKER_EXIT_POLL_MS = 20;
const WORKER_EXIT_ATTEMPTS = 150;

/** 이 stateRoot를 소유한 워커를 종료시키고 실제로 나갈 때까지 기다린다. */
export async function stopCommandHostWorker(stateRoot: string): Promise<void> {
  const paths = await resolveCommandHostPaths(stateRoot).catch(() => undefined);
  if (paths === undefined) {
    return;
  }
  const lock = await readCommandHostLock(paths.lockPath);
  if (lock !== 'missing' && lock !== 'unparsable' && lock.pid !== process.pid) {
    try {
      // SIGTERM은 워커의 정상 종료 절차다 — 세션을 거두고 lock을 놓는다.
      process.kill(lock.pid, 'SIGTERM');
    } catch {
      // 이미 스스로 나갔다.
    }
    for (
      let attempt = 0;
      attempt < WORKER_EXIT_ATTEMPTS && isProcessAlive(lock.pid);
      attempt += 1
    ) {
      await delay(WORKER_EXIT_POLL_MS);
    }
  }
  await rm(paths.lockPath, { force: true });
}

/** 워커를 먼저 세운 뒤 작업공간을 지운다. 테스트 teardown의 기본형이다. */
export async function removeCommandHostWorkspace(
  stateRoot: string,
): Promise<void> {
  await stopCommandHostWorker(stateRoot);
  await rm(stateRoot, { recursive: true, force: true });
}
