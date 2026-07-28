import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';

import { createCommandSessionHost } from '../../command-host/session-core.js';
import { createHostRoutedComputerSessionDiscoveryCommandRunner } from '../computer-discovery-command-runner.js';
import {
  discoverComputerSessionDefaults,
  type ComputerSessionDiscoveryCommandInvocation,
  type ComputerSessionDiscoveryCommandResult,
} from './computer-session-defaults.js';

interface DiscoveryObservation {
  invocation: ComputerSessionDiscoveryCommandInvocation;
  result: ComputerSessionDiscoveryCommandResult;
}

function readAbsoluteWindowsPaths(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const paths: string[] = [];
  for (const value of values) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const path: unknown = Reflect.get(value, 'path');
    if (typeof path === 'string' && win32.isAbsolute(path)) {
      paths.push(win32.normalize(path));
    }
  }
  return paths;
}

void test(
  'native Windows discovers real drives and known folders through command-host',
  {
    skip:
      process.platform === 'win32'
        ? false
        : 'requires a native Windows PowerShell and filesystem boundary',
  },
  async (t) => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat Windows 경로-새싹🌱-'),
    );
    const inlineMaxBytes = 1024 * 1024;
    const host = createCommandSessionHost({
      inlineMaxBytes,
      tailRingBytes: inlineMaxBytes,
    });
    t.after(async () => {
      const closed = await host.closeAll();
      assert.equal(closed.ok, true);
      await rm(stateRoot, { recursive: true, force: true });
    });

    const runDiscoveryCommand =
      createHostRoutedComputerSessionDiscoveryCommandRunner({
        hostCommands: host,
        stateRoot,
        inlineMaxBytes,
      });
    const observations: DiscoveryObservation[] = [];
    const outcome = await discoverComputerSessionDefaults({
      runDiscoveryCommandAsync: async (invocation) => {
        const result = await runDiscoveryCommand(invocation);
        observations.push({ invocation, result });
        return result;
      },
    });

    assert.equal(observations.length, 2);
    for (const observation of observations) {
      assert.match(observation.invocation.executable, /powershell\.exe$/i);
      assert.equal(observation.invocation.windowsHide, true);
      assert.equal(
        observation.result.error,
        undefined,
        `${observation.invocation.executable} failed: ${
          observation.result.error?.message ?? 'unknown error'
        }; status=${String(observation.result.status)}`,
      );
      assert.equal(observation.result.status, 0);
      assert.notEqual(observation.result.stdout.trim(), '');
    }
    assert.equal(outcome.complete, true);

    const drivePaths = readAbsoluteWindowsPaths(
      observations[0]?.result.stdout ?? '',
    );
    const knownFolderPaths = readAbsoluteWindowsPaths(
      observations[1]?.result.stdout ?? '',
    );
    assert.ok(
      drivePaths.length > 0,
      'Windows reports at least one ready drive',
    );
    assert.ok(
      knownFolderPaths.length > 0,
      'Windows reports at least one existing user known folder',
    );

    for (const expectedPath of [...drivePaths, ...knownFolderPaths]) {
      assert.ok(
        outcome.defaults.browseLocations.some(
          (location) =>
            win32.normalize(location.path).toLowerCase() ===
            expectedPath.toLowerCase(),
        ),
        `the discovered location is projected: ${expectedPath}`,
      );
    }
    assert.equal(outcome.defaults.root, win32.parse(stateRoot).root);
    assert.ok(
      stateRoot.includes(' ') &&
        stateRoot.includes('경로') &&
        stateRoot.includes('🌱'),
      'the real host commands ran from the native spaces/Korean/emoji path',
    );
  },
);
