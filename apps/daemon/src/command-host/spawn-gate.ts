import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { platform } from 'node:os';
import type { Writable } from 'node:stream';

// P7.5 spec v4 §5.1 실행 게이트 — 자식은 fd3에서 한 줄을 읽기 전까지 exec하지
// 않는다. 워커는 journal open 행의 fdatasync가 성공한 뒤에만 GO를 쓰므로
// "journal에 없는 자식은 존재할 수 없다"가 성립한다. GO 전에 워커가 죽으면
// 파이프가 닫히고 자식은 exec 없이 종료한다.

const GATE_FD = 3;
const GATE_SHELL = '/bin/sh';
// GO를 읽은 뒤 fd3을 닫고 exec한다 — 실제 명령이 게이트 파이프를 물려받아
// 열어두지 않게 한다.
const GATE_SCRIPT = 'IFS= read -r _ <&3 || exit 1; exec 3<&-; exec "$@"';
const GATE_GO = '\n';

interface GatedChildProcess {
  child: ChildProcessWithoutNullStreams;
  /** GO. journal open 행 fdatasync 성공 이후에만 호출한다. */
  release(): void;
  /** GO 없이 게이트를 닫는다 — 자식은 EOF를 보고 exec 없이 종료한다. */
  abort(): void;
  /** false면 게이트 없는 명시 강등(win32·게이트 구성 실패). */
  gated: boolean;
}

export function spawnGatedChild(args: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): GatedChildProcess {
  if (platform() === 'win32') {
    // Windows는 worker 모드 비지원이고 프로세스 그룹 의미론도 다르다 —
    // inline 현행 동작을 유지하는 명시 강등이다 (§4.5·§5.1).
    return ungated(spawnDirect(args));
  }
  const child = spawn(
    GATE_SHELL,
    ['-c', GATE_SCRIPT, 'sh', args.executable, ...args.args],
    {
      cwd: args.cwd,
      env: args.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  const gate = resolveGateWriter(child);
  if (gate === undefined) {
    // 게이트 fd를 얻지 못하면 자식은 영원히 대기한다 — 거두고 강등한다.
    child.kill('SIGKILL');
    return ungated(spawnDirect(args));
  }
  // 게이트는 한 번 쓰고 버리는 신호 채널이다. 자식이 GO를 읽기 전에 죽으면
  // (강제 종료·크래시) 파이프가 EPIPE/ECONNRESET을 올리는데, 그것은 세션
  // 의미론이 아니라 게이트가 제 역할을 마쳤다는 뜻이다.
  gate.on('error', () => undefined);
  let settled = false;
  return {
    child,
    gated: true,
    release() {
      if (settled) {
        return;
      }
      settled = true;
      gate.end(GATE_GO);
    },
    abort() {
      if (settled) {
        return;
      }
      settled = true;
      gate.end();
    },
  };
}

function spawnDirect(args: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ChildProcessWithoutNullStreams {
  return spawn(args.executable, args.args, {
    cwd: args.cwd,
    env: args.env,
    detached: platform() !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function ungated(child: ChildProcessWithoutNullStreams): GatedChildProcess {
  return {
    child,
    gated: false,
    release() {
      // 게이트가 없으면 자식은 이미 실행 중이다.
    },
    abort() {
      child.kill('SIGKILL');
    },
  };
}

function resolveGateWriter(
  child: ChildProcessWithoutNullStreams,
): Writable | undefined {
  const extra = child.stdio[GATE_FD];
  if (extra === null || extra === undefined) {
    return undefined;
  }
  return 'write' in extra ? extra : undefined;
}
