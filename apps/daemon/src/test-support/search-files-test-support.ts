import { after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemonContext } from '../daemon/context.js';
import { searchFilesTool } from '../daemon/tools/builtin/search-files.js';

const previousComputerSessionDisabled =
  process.env['GEULBAT_COMPUTER_SESSION_DISABLED'];
const previousCommandHostMode = process.env['GEULBAT_COMMAND_HOST'];
process.env['GEULBAT_COMPUTER_SESSION_DISABLED'] = '1';
process.env['GEULBAT_COMMAND_HOST'] = 'inline';
const searchFilesStateRoot = mkdtempSync(
  join(tmpdir(), 'geulbat-search-command-state-'),
);
const searchFilesRuntime = createDaemonContext({
  homeStateRoot: searchFilesStateRoot,
});
if (previousComputerSessionDisabled === undefined) {
  delete process.env['GEULBAT_COMPUTER_SESSION_DISABLED'];
} else {
  process.env['GEULBAT_COMPUTER_SESSION_DISABLED'] =
    previousComputerSessionDisabled;
}
if (previousCommandHostMode === undefined) {
  delete process.env['GEULBAT_COMMAND_HOST'];
} else {
  process.env['GEULBAT_COMMAND_HOST'] = previousCommandHostMode;
}
after(async () => {
  await searchFilesRuntime.hostCommands.closeAll();
  await rm(searchFilesStateRoot, { recursive: true, force: true });
});

export const executeSearchFiles: typeof searchFilesTool.execute = (args, ctx) =>
  searchFilesTool.execute(args, {
    ...ctx,
    stateRoot: ctx.stateRoot ?? searchFilesStateRoot,
    workingDirectory: ctx.workingDirectory ?? '',
    runtimeServices: searchFilesRuntime,
  });
