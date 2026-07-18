import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

if (process.env.GEULBAT_DEV_SKIP_PRECHECK === '1') {
  console.error(
    '[daemon-dev] skipping precheck (GEULBAT_DEV_SKIP_PRECHECK=1). Use `npm run check -w apps/daemon` when you want the full gate.',
  );
  process.exit(0);
}

console.error(
  '[daemon-dev] checked startup: build:deps + check:app. Use the standard `npm run dev -w apps/daemon` for development startup without this full gate.',
);

const steps = [
  ['npm', ['run', 'build:deps']],
  ['npm', ['run', 'check:app']],
];

for (const [command, args] of steps) {
  const started = Date.now();
  console.error(`[daemon-dev] running ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: daemonRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const elapsedMs = Date.now() - started;
  if (result.error) {
    console.error(
      `[daemon-dev] precheck failed after ${elapsedMs}ms:`,
      result.error,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[daemon-dev] precheck failed: ${command} ${args.join(' ')} exited ${String(result.status)} after ${elapsedMs}ms`,
    );
    process.exit(result.status ?? 1);
  }
  console.error(`[daemon-dev] ${args.join(' ')} ok in ${elapsedMs}ms`);
}
