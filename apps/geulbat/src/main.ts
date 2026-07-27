import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { launchDaemonHost } from '@geulbat/daemon/host';
import { resolveHomeStateRoot } from '@geulbat/daemon/home-state-root';
import { readDaemonInstanceAdmissionLockOwner } from '@geulbat/daemon/instance-admission-lock';
import { notifyDaemonLifecycleReady } from '@geulbat/daemon-lifecycle/daemon-child';
import type { DaemonShutdownSignal } from '@geulbat/daemon-lifecycle/protocol';
import { createLogger } from '@geulbat/structured-logger/logger';

import {
  createProductComputerSessionAdapter,
  readProductComputerSessionId,
} from './computer-session-adapter.js';
import { resolveBundledShellAssetRoot } from './bundled-shell-assets.js';
import { discoverRunningDaemonShell } from './daemon-shell-discovery.js';
import { openUrlInBrowser } from './open-browser.js';
import { createProductXHarnessAdmission } from './product-xharness-admission.js';

const GEULBAT_DAEMON_CHILD_ARGUMENT = '--geulbat-daemon-child';
const logger = createLogger('geulbat');
const bundledCreatorPluginRoot = fileURLToPath(
  new URL('../../daemon/creator-plugin', import.meta.url),
);

/**
 * 기록된 데몬이 지금도 도는지. lock은 프로세스가 죽어도 남을 수 있으므로 pid
 * 생존이 판정의 일부다. 신호 0은 프로세스를 건드리지 않고 존재만 확인한다.
 */
function isProcessAliveByPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 데몬이 준비된 뒤 화면을 연다. lifecycle 이벤트 핸들러는 동기이므로 실패를
 * 스스로 처리해야 한다 — 브라우저를 못 열었다는 사실은 남기고, 사용자가 주소를
 * 직접 열 수 있게 그 주소도 함께 남긴다.
 */
function openDaemonShellWhenReady(): void {
  discoverRunningDaemonShell({
    isProcessAlive: isProcessAliveByPid,
    readLockOwner: () =>
      readDaemonInstanceAdmissionLockOwner(resolveHomeStateRoot()),
  })
    .then(async (running) => {
      if (running === null) {
        logger.warn(
          'daemon reported ready but recorded no listening port; open the shell manually',
        );
        return;
      }
      logger.info('opening the shell', { url: running.url });
      await openUrlInBrowser(running.url);
    })
    .catch((error: unknown) => {
      logger.error('could not open the shell in a browser:', {
        message: error instanceof Error ? error.message : 'unknown failure',
      });
    });
}

async function runProduct(): Promise<void> {
  if (process.argv.includes(GEULBAT_DAEMON_CHILD_ARGUMENT)) {
    if (process.send === undefined) {
      throw new Error('daemon child requires the lifecycle worker IPC channel');
    }
    const shellAssets = resolveBundledShellAssetRoot({
      moduleUrl: import.meta.url,
      entryDocumentExists: existsSync,
    });
    if (shellAssets.shellAssetRoot === null) {
      // 조용히 넘기지 않는다. shell 없이도 API와 데몬은 서지만, 브라우저로 열
      // 화면이 없다는 사실을 이유와 경로와 함께 남긴다.
      logger.error(
        'bundled web-shell build is missing; the daemon will serve the API only',
        {
          expectedRoot: shellAssets.resolvedPath,
        },
      );
    }
    await launchDaemonHost({
      agentLoopImplementationAdmission: createProductXHarnessAdmission(),
      bundledCreatorPluginRoot,
      computerSessionId: readProductComputerSessionId(),
      ...(shellAssets.shellAssetRoot === null
        ? {}
        : { shellAssetRoot: shellAssets.shellAssetRoot }),
    });
    await notifyDaemonLifecycleReady();
    return;
  }

  // 이미 도는 데몬이 있으면 새로 띄우지 않는다. admission lock이 한 Geulbat
  // Home에 하나의 데몬만 허용하므로, 두 번째 실행은 충돌 오류가 아니라 그
  // 데몬의 화면을 여는 것이 옳은 동작이다.
  const running = await discoverRunningDaemonShell({
    isProcessAlive: isProcessAliveByPid,
    readLockOwner: () =>
      readDaemonInstanceAdmissionLockOwner(resolveHomeStateRoot()),
  });
  if (running !== null) {
    logger.info('daemon already running; opening its shell', {
      url: running.url,
      pid: running.pid,
    });
    await openUrlInBrowser(running.url);
    return;
  }

  const lifecycle = createProductComputerSessionAdapter({
    daemonChildArgument: GEULBAT_DAEMON_CHILD_ARGUMENT,
    onEvent: (event) => {
      if (event.state === 'ready') {
        openDaemonShellWhenReady();
        return;
      }
      if (event.state !== 'restarting') {
        return;
      }
      const { code, signal } = event;
      logger.warn('daemon exited unexpectedly; restarting', { code, signal });
    },
  });
  const forwardSignal = (signal: DaemonShutdownSignal): void => {
    lifecycle.shutdown(signal);
  };
  const onSigint = (): void => forwardSignal('SIGINT');
  const onSigterm = (): void => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await lifecycle.run();
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

runProduct().catch((error: unknown) => {
  logger.error('startup failed:', {
    message: error instanceof Error ? error.message : 'unknown startup failure',
  });
  process.exit(1);
});
