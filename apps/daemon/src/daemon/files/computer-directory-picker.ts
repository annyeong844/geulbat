import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

const WSL_PWSH_PATH = '/mnt/c/Program Files/PowerShell/7/pwsh.exe';
const WINDOWS_PWSH_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WSL_WINDOWS_POWERSHELL_PATH =
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WINDOWS_WINDOWS_POWERSHELL_PATH =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_FOLDER_PICKER_INITIAL_PATH_PLACEHOLDER =
  '__GEULBAT_DIRECTORY_PICKER_INITIAL_PATH_BASE64__';
const WINDOWS_FOLDER_PICKER_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = '시작 위치 선택'
$dialog.ShowNewFolderButton = $true
$initialPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${WINDOWS_FOLDER_PICKER_INITIAL_PATH_PLACEHOLDER}'))
if ($initialPath -and [System.IO.Directory]::Exists($initialPath)) {
  $dialog.SelectedPath = $initialPath
}
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
`;

interface RunCommandResult {
  stdout: string;
}

interface RunCommandOptions {
  signal?: AbortSignal;
}

type RunCommand = (
  command: string,
  args: readonly string[],
  options?: RunCommandOptions,
) => Promise<RunCommandResult>;

type ComputerDirectoryPickerSelection =
  | { kind: 'cancelled' }
  | { kind: 'selected'; absolutePath: string };

export interface ComputerDirectoryPicker {
  select(args: {
    initialAbsolutePath: string;
    signal?: AbortSignal;
  }): Promise<ComputerDirectoryPickerSelection>;
  close(): Promise<void>;
}

export class ComputerDirectoryPickerError extends Error {
  readonly code: 'execution_failed' | 'unavailable';

  constructor(code: 'execution_failed' | 'unavailable', message: string) {
    super(message);
    this.name = 'ComputerDirectoryPickerError';
    this.code = code;
  }
}

interface CreateComputerDirectoryPickerOptions {
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  isDirectory?: (path: string) => Promise<boolean>;
  runCommand?: RunCommand;
}

export function createComputerDirectoryPicker(
  options: CreateComputerDirectoryPickerOptions = {},
): ComputerDirectoryPicker {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const runCommand = options.runCommand ?? runCommandWithExecFile;
  let activeSelection:
    | {
        key: symbol;
        controller: AbortController;
        promise: Promise<ComputerDirectoryPickerSelection>;
      }
    | undefined;

  return {
    select({ initialAbsolutePath, signal }) {
      if (activeSelection !== undefined) {
        return activeSelection.promise;
      }

      const key = Symbol('computer-directory-picker-selection');
      const controller = new AbortController();
      const stopRelayingAbort = relayAbort(signal, controller);
      const promise = selectComputerDirectory({
        controller,
        fileExists,
        initialAbsolutePath,
        isDirectory,
        platform,
        runCommand,
      })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return { kind: 'cancelled' } as const;
          }
          throw error;
        })
        .finally(() => {
          stopRelayingAbort();
          if (activeSelection?.key === key) {
            activeSelection = undefined;
          }
        });
      activeSelection = { key, controller, promise };
      return promise;
    },

    async close() {
      const selection = activeSelection;
      if (selection === undefined) {
        return;
      }
      selection.controller.abort();
      await selection.promise;
    },
  };
}

async function selectComputerDirectory(args: {
  controller: AbortController;
  fileExists: (path: string) => boolean;
  initialAbsolutePath: string;
  isDirectory: (path: string) => Promise<boolean>;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
}): Promise<ComputerDirectoryPickerSelection> {
  const { signal } = args.controller;
  if (signal.aborted) {
    return { kind: 'cancelled' };
  }
  const runtime = resolvePickerRuntime(args.platform, args.fileExists);
  const initialNativePath =
    runtime.kind === 'wsl'
      ? await convertPathWithWslPath(
          args.runCommand,
          '-w',
          args.initialAbsolutePath,
          signal,
        )
      : args.initialAbsolutePath;
  const encodedCommand =
    buildWindowsFolderPickerEncodedCommand(initialNativePath);
  let selectedNativePath: string;
  try {
    const result = await args.runCommand(
      runtime.powershellCommand,
      ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encodedCommand],
      { signal },
    );
    selectedNativePath = result.stdout.trim();
  } catch {
    throw new ComputerDirectoryPickerError(
      'execution_failed',
      '운영체제 폴더 선택 창을 열지 못했습니다.',
    );
  }

  if (signal.aborted || selectedNativePath === '') {
    return { kind: 'cancelled' };
  }
  const selectedAbsolutePath =
    runtime.kind === 'wsl'
      ? await convertPathWithWslPath(
          args.runCommand,
          '-u',
          selectedNativePath,
          signal,
        )
      : selectedNativePath;
  if (signal.aborted) {
    return { kind: 'cancelled' };
  }
  if (!(await args.isDirectory(selectedAbsolutePath))) {
    throw new ComputerDirectoryPickerError(
      'execution_failed',
      '선택한 폴더를 현재 실행 환경에서 열 수 없습니다.',
    );
  }
  return { kind: 'selected', absolutePath: selectedAbsolutePath };
}

function relayAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) {
    return () => {};
  }
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => {};
  }
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function buildWindowsFolderPickerEncodedCommand(
  initialNativePath: string,
): string {
  const initialPathBase64 = Buffer.from(initialNativePath, 'utf8').toString(
    'base64',
  );
  const pickerScript = WINDOWS_FOLDER_PICKER_SCRIPT.replace(
    WINDOWS_FOLDER_PICKER_INITIAL_PATH_PLACEHOLDER,
    initialPathBase64,
  );
  return Buffer.from(pickerScript, 'utf16le').toString('base64');
}

function resolvePickerRuntime(
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean,
):
  | { kind: 'windows'; powershellCommand: string }
  | { kind: 'wsl'; powershellCommand: string } {
  if (platform === 'win32' && fileExists(WINDOWS_PWSH_PATH)) {
    return { kind: 'windows', powershellCommand: WINDOWS_PWSH_PATH };
  }
  if (platform === 'win32' && fileExists(WINDOWS_WINDOWS_POWERSHELL_PATH)) {
    return {
      kind: 'windows',
      powershellCommand: WINDOWS_WINDOWS_POWERSHELL_PATH,
    };
  }
  if (platform === 'linux' && fileExists(WSL_PWSH_PATH)) {
    return { kind: 'wsl', powershellCommand: WSL_PWSH_PATH };
  }
  if (platform === 'linux' && fileExists(WSL_WINDOWS_POWERSHELL_PATH)) {
    return {
      kind: 'wsl',
      powershellCommand: WSL_WINDOWS_POWERSHELL_PATH,
    };
  }
  throw new ComputerDirectoryPickerError(
    'unavailable',
    '이 실행 환경에서는 운영체제 폴더 선택 창을 사용할 수 없습니다.',
  );
}

async function convertPathWithWslPath(
  runCommand: RunCommand,
  direction: '-u' | '-w',
  path: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await runCommand('wslpath', [direction, path], { signal });
    const converted = result.stdout.trim();
    if (converted !== '') {
      return converted;
    }
  } catch {
    // The public error below intentionally hides child-process details.
  }
  throw new ComputerDirectoryPickerError(
    'execution_failed',
    '선택한 폴더 경로를 Windows와 WSL 사이에서 변환하지 못했습니다.',
  );
}

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function runCommandWithExecFile(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: 'utf8',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error: Error | null, stdout: string) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}
