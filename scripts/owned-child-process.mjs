import { spawn } from 'node:child_process';
import process from 'node:process';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

function isNoSuchProcess(error) {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function signalPosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    throw error;
  }
}

async function waitForPosixProcessGroupExit(pid) {
  while (signalPosixProcessGroup(pid, 0)) {
    await waitForImmediate();
  }
}

function terminateWindowsProcessTree(child, signal) {
  return new Promise((resolve, reject) => {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    let spawnError;
    killer.once('error', (error) => {
      spawnError = error;
    });
    killer.once('close', (code) => {
      if (spawnError === undefined && code === 0) {
        resolve();
        return;
      }

      child.kill(signal);
      reject(
        spawnError ??
          new Error(
            `taskkill failed for owned process tree ${child.pid} with exit code ${code ?? 1}`,
          ),
      );
    });
  });
}

/**
 * Spawn a process whose descendants can be settled before invocation-owned
 * files are removed. POSIX children lead a process group; native Windows uses
 * taskkill /T for awaited interrupt cleanup.
 */
export function spawnOwnedChildProcess(command, args, options = {}) {
  const platform = process.platform;
  const child = spawn(command, args, {
    ...options,
    detached: platform !== 'win32',
  });
  let spawnError;
  const exitPromise = new Promise((resolveExit) => {
    let settled = false;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveExit(result);
    };
    child.once('error', (error) => {
      spawnError = error;
      settle({ code: 1, error, signal: null });
    });
    child.once('exit', (code, signal) => {
      settle({
        code: spawnError === undefined ? (code ?? 1) : 1,
        ...(spawnError === undefined ? {} : { error: spawnError }),
        signal,
      });
    });
  });
  const closePromise = new Promise((resolveClose) => {
    child.once('close', (code, signal) => {
      resolveClose({
        code: spawnError === undefined ? (code ?? 1) : 1,
        ...(spawnError === undefined ? {} : { error: spawnError }),
        signal,
      });
    });
  });
  let terminationPromise;

  return {
    child,
    waitForExit() {
      return exitPromise;
    },
    waitForClose() {
      return closePromise;
    },
    terminateTree(signal) {
      if (terminationPromise !== undefined) {
        return terminationPromise;
      }
      if (typeof child.pid !== 'number') {
        terminationPromise = Promise.resolve();
        return terminationPromise;
      }

      if (platform === 'win32') {
        terminationPromise = terminateWindowsProcessTree(child, signal);
      } else {
        terminationPromise = Promise.resolve().then(() => {
          signalPosixProcessGroup(child.pid, signal);
        });
      }
      return terminationPromise;
    },
    async settleTree() {
      await terminationPromise;
      if (platform === 'win32' || typeof child.pid !== 'number') {
        return;
      }

      signalPosixProcessGroup(child.pid, 'SIGKILL');
      await waitForPosixProcessGroupExit(child.pid);
    },
  };
}
