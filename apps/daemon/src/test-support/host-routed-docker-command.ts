import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCommandSessionHost } from '../command-host/session-core.js';
import type {
  DockerClientCommandInvocation,
  DockerClientCommandResult,
} from '../daemon/docker-client-command.js';
import { createHostRoutedDockerCommandRunner } from '../daemon/docker-host-command.js';

const TEST_HOST_COMMAND_PAGE_BYTES = 16 * 1024;

export async function runHostRoutedDockerCommandForTest(
  invocation: DockerClientCommandInvocation,
  options: { stateRoot?: string } = {},
): Promise<DockerClientCommandResult> {
  const ownsStateRoot = options.stateRoot === undefined;
  const stateRoot =
    options.stateRoot ??
    (await mkdtemp(join(tmpdir(), 'geulbat-test-host-routed-command-')));
  const hostCommands = createCommandSessionHost({
    inlineMaxBytes: TEST_HOST_COMMAND_PAGE_BYTES,
    tailRingBytes: TEST_HOST_COMMAND_PAGE_BYTES,
  });
  const runCommand = createHostRoutedDockerCommandRunner({
    hostCommands,
    stateRoot,
    pageLimitBytes: TEST_HOST_COMMAND_PAGE_BYTES,
  });
  try {
    return await runCommand(invocation);
  } finally {
    await hostCommands.closeAll();
    if (ownsStateRoot) {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
}
