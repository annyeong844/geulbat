import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ComputerDirectoryPickerError,
  createComputerDirectoryPicker,
} from './computer-directory-picker.js';

void test('WSL native directory picker converts the initial and selected Windows paths', async () => {
  const calls: Array<{
    command: string;
    args: readonly string[];
  }> = [];
  const picker = createComputerDirectoryPicker({
    platform: 'linux',
    fileExists: (path) => path.endsWith('pwsh.exe'),
    isDirectory: async (path) => path === '/mnt/c/Users/user/Downloads/repo',
    async runCommand(command, args) {
      calls.push({ command, args });
      if (command === 'wslpath' && args[0] === '-w') {
        return { stdout: 'C:\\Users\\user\r\n' };
      }
      if (command === 'wslpath' && args[0] === '-u') {
        return { stdout: '/mnt/c/Users/user/Downloads/repo\n' };
      }
      return { stdout: 'C:\\Users\\user\\Downloads\\repo\r\n' };
    },
  });

  const result = await picker.select({
    initialAbsolutePath: '/mnt/c/Users/user',
  });

  assert.deepEqual(result, {
    kind: 'selected',
    absolutePath: '/mnt/c/Users/user/Downloads/repo',
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]?.args, ['-w', '/mnt/c/Users/user']);
  assert.equal(calls[1]?.command.endsWith('pwsh.exe'), true);
  assert.equal(
    calls[1]?.args.includes('-WindowStyle'),
    false,
    'hiding the PowerShell host also hides the WPF folder dialog under WSL',
  );
  const encodedCommandIndex = calls[1]?.args.indexOf('-EncodedCommand') ?? -1;
  assert.notEqual(encodedCommandIndex, -1);
  const encodedCommand = calls[1]?.args[encodedCommandIndex + 1];
  assert.ok(encodedCommand);
  const pickerScript = Buffer.from(encodedCommand, 'base64').toString(
    'utf16le',
  );
  const initialPathMatch = /FromBase64String\('([^']+)'\)/u.exec(pickerScript);
  assert.ok(initialPathMatch?.[1]);
  assert.equal(
    Buffer.from(initialPathMatch[1], 'base64').toString('utf8'),
    'C:\\Users\\user',
  );
  assert.deepEqual(calls[2]?.args, ['-u', 'C:\\Users\\user\\Downloads\\repo']);
});

void test('native directory picker falls back to built-in Windows PowerShell on Windows and WSL', async () => {
  const scenarios = [
    {
      platform: 'win32',
      initialAbsolutePath: 'C:\\Users\\user',
      expectedCommand:
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    },
    {
      platform: 'linux',
      initialAbsolutePath: '/mnt/c/Users/user',
      expectedCommand:
        '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    },
  ] as const;

  for (const scenario of scenarios) {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const picker = createComputerDirectoryPicker({
      platform: scenario.platform,
      fileExists: (path) => path === scenario.expectedCommand,
      isDirectory: async () => false,
      async runCommand(command, args) {
        calls.push({ command, args });
        if (command === 'wslpath') {
          return { stdout: 'C:\\Users\\user\r\n' };
        }
        return { stdout: '' };
      },
    });

    assert.deepEqual(
      await picker.select({
        initialAbsolutePath: scenario.initialAbsolutePath,
      }),
      { kind: 'cancelled' },
    );
    const pickerCall = calls.find(
      ({ command }) => command === scenario.expectedCommand,
    );
    assert.ok(pickerCall);
    const encodedCommandIndex = pickerCall.args.indexOf('-EncodedCommand');
    assert.notEqual(encodedCommandIndex, -1);
    const encodedCommand = pickerCall.args[encodedCommandIndex + 1];
    assert.ok(encodedCommand);
    const pickerScript = Buffer.from(encodedCommand, 'base64').toString(
      'utf16le',
    );
    assert.match(pickerScript, /System\.Windows\.Forms\.FolderBrowserDialog/u);
    assert.doesNotMatch(pickerScript, /Microsoft\.Win32\.OpenFolderDialog/u);
  }
});

void test('native directory picker joins concurrent requests to one host dialog', async () => {
  let commandCount = 0;
  let finishCommand: ((result: { stdout: string }) => void) | undefined;
  const commandResult = new Promise<{ stdout: string }>((resolve) => {
    finishCommand = resolve;
  });
  const picker = createComputerDirectoryPicker({
    platform: 'win32',
    fileExists: () => true,
    isDirectory: async () => false,
    runCommand() {
      commandCount += 1;
      return commandResult;
    },
  });

  const firstSelection = picker.select({
    initialAbsolutePath: 'C:\\Users\\user',
  });
  const secondSelection = picker.select({
    initialAbsolutePath: 'C:\\Users\\user',
  });

  assert.equal(commandCount, 1);
  assert.ok(finishCommand);
  finishCommand({ stdout: '' });
  assert.deepEqual(await Promise.all([firstSelection, secondSelection]), [
    { kind: 'cancelled' },
    { kind: 'cancelled' },
  ]);
});

void test('closing the picker aborts its active host process and permits a later selection', async () => {
  let commandCount = 0;
  let activeSignal: AbortSignal | undefined;
  let markCommandStarted: (() => void) | undefined;
  const commandStarted = new Promise<void>((resolve) => {
    markCommandStarted = resolve;
  });
  const picker = createComputerDirectoryPicker({
    platform: 'win32',
    fileExists: () => true,
    isDirectory: async () => false,
    runCommand(_command, _args, options) {
      commandCount += 1;
      if (commandCount > 1) {
        return Promise.resolve({ stdout: '' });
      }
      activeSignal = options?.signal;
      assert.ok(activeSignal);
      markCommandStarted?.();
      return new Promise((resolve, reject) => {
        const rejectForAbort = () => reject(new Error('picker aborted'));
        if (activeSignal?.aborted === true) {
          rejectForAbort();
          return;
        }
        activeSignal?.addEventListener('abort', rejectForAbort, { once: true });
      });
    },
  });

  const activeSelection = picker.select({
    initialAbsolutePath: 'C:\\Users\\user',
  });
  await commandStarted;
  const close = picker.close();

  assert.equal(activeSignal?.aborted, true);
  await close;
  assert.deepEqual(await activeSelection, { kind: 'cancelled' });
  assert.deepEqual(
    await picker.select({ initialAbsolutePath: 'C:\\Users\\user' }),
    { kind: 'cancelled' },
  );
  assert.equal(commandCount, 2);
});

void test('native directory picker preserves cancellation without path conversion', async () => {
  let callCount = 0;
  const picker = createComputerDirectoryPicker({
    platform: 'win32',
    fileExists: () => true,
    isDirectory: async () => false,
    async runCommand() {
      callCount += 1;
      return { stdout: '' };
    },
  });

  assert.deepEqual(
    await picker.select({ initialAbsolutePath: 'C:\\Users\\user' }),
    { kind: 'cancelled' },
  );
  assert.equal(callCount, 1);
});

void test('native directory picker fails visibly when no supported host dialog exists', async () => {
  const picker = createComputerDirectoryPicker({
    platform: 'linux',
    fileExists: () => false,
  });

  await assert.rejects(
    picker.select({ initialAbsolutePath: '/home/user' }),
    (error: unknown) =>
      error instanceof ComputerDirectoryPickerError &&
      error.code === 'unavailable',
  );
});
