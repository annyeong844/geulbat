import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// P7.5 spec v4 §14 수용기준 8 — "허용 목록 외 타이머 부재".
//
// 이 페이즈는 "종료는 이벤트가 정한다"를 설계 원칙으로 삼았다: linger·
// deadline·폴링 타이머를 두는 순간 그 원칙이 조용히 무너진다. 원칙을
// 지켜줄 장치가 사람의 눈뿐이면 언젠가는 새므로, 허용 목록을 소스에서
// 직접 세어 고정한다. 타이머를 늘리려면 이 표를 함께 고쳐야 하고, 그
// 순간이 곧 "이 타이머가 정말 필요한가"를 심사하는 자리다.

interface AllowedTimerSite {
  file: string;
  /** `setTimeout(`·`setInterval(`·`setImmediate(` 호출 수. */
  calls: number;
  /** `node:timers`에서 가져오는 import 수. */
  timerImports: number;
  why: string;
}

const ALLOWED: readonly AllowedTimerSite[] = [
  {
    file: 'session-core.ts',
    calls: 3,
    timerImports: 0,
    why: '호출자 timeoutMs(§4.6) · 요청 종료 SIGTERM 유예 1초(§4.5) · 호출자 yieldTimeMs',
  },
  {
    file: 'main.ts',
    calls: 1,
    timerImports: 0,
    why: '기동 유예 — 연결이 한 번도 오지 않은 워커에게는 §6.3의 종료 이벤트가 영영 오지 않는다. "아직 안 왔다"와 "영영 안 온다"는 시간 없이 구별할 수 없어, 접속 창의 2배를 기다린 뒤 한 번만 판정한다(§7의 COMMAND_HOST_STARTUP_GRACE_MS에서 파생)',
  },
  {
    file: 'daemon-client.ts',
    calls: 0,
    timerImports: 1,
    why: '워커 접속 재시도 백오프 — §3이 명시적으로 허용하는 유일한 대기',
  },
  {
    file: 'worker-server.ts',
    calls: 1,
    timerImports: 0,
    why: '재입양 창(P7.6 §7.1) — 시스템 세션의 고정이 풀린 순간에는 "데몬만 죽었다"와 "앱이 종료됐다"가 구별되지 않는다. 창 안에 그 세션을 다시 고정하면 이어지고, 지나면 회수한다. 연결 수가 아니라 세션 단위로 세는 이유는 돌아오기만 하고 다시 고정하지 않는 경우가 정상 경로이기 때문이다. 기동 유예와 같은 구별이므로 같은 값(COMMAND_HOST_STARTUP_GRACE_MS)에서 파생하며 새 숫자를 만들지 않는다',
  },
];

const TIMER_CALL = /\b(?:setTimeout|setInterval|setImmediate)\s*\(/gu;
const TIMER_IMPORT = /from\s+'node:timers(?:\/promises)?'/gu;

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

void test('수용기준 8: no timer exists outside the allow list', async () => {
  const sourceDirectory = fileURLToPath(
    new URL('../../src/command-host/', import.meta.url),
  );
  const names = (await readdir(sourceDirectory)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  assert.ok(
    names.length > 5,
    `the scan must actually see the sources, found ${names.length}`,
  );

  const observed = new Map<string, { calls: number; timerImports: number }>();
  for (const name of names) {
    const source = await readFile(join(sourceDirectory, name), 'utf8');
    const calls = countMatches(source, TIMER_CALL);
    const timerImports = countMatches(source, TIMER_IMPORT);
    if (calls > 0 || timerImports > 0) {
      observed.set(name, { calls, timerImports });
    }
  }

  const allowed = new Map(
    ALLOWED.map((site) => [
      site.file,
      { calls: site.calls, timerImports: site.timerImports },
    ]),
  );
  for (const [name, counts] of observed) {
    const expected = allowed.get(name);
    assert.ok(
      expected !== undefined,
      `${name} acquired a timer that no §3 allowance covers — justify it in ALLOWED or make the wait event-driven`,
    );
    assert.deepEqual(
      counts,
      expected,
      `${name} timer count changed; every timer in this phase needs a stated reason`,
    );
  }
  for (const site of ALLOWED) {
    assert.ok(
      observed.has(site.file),
      `${site.file} no longer holds the timer it was allowed for (${site.why}) — drop the entry`,
    );
  }
});
