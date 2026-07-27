import { spawn } from 'node:child_process';

export interface ProductXHarnessGitProcessResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface ProductXHarnessGitProcessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
}

export async function runProductXHarnessGitProcess(
  repositoryRoot: string,
  args: readonly string[],
  options: ProductXHarnessGitProcessOptions = {},
): Promise<ProductXHarnessGitProcessResult> {
  return await new Promise<ProductXHarnessGitProcessResult>(
    (resolve, reject) => {
      const child = spawn('git', ['-C', repositoryRoot, ...args], {
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => {
        if (signal !== null) {
          reject(new Error(`git terminated by signal ${signal}`));
          return;
        }
        resolve(
          Object.freeze({
            exitCode: exitCode ?? 1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          }),
        );
      });
      child.stdin.end(options.input);
    },
  );
}
