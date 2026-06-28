import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  applyPtcHostPathMode,
  PtcHostPathModeError,
  ptcHostPathModeDiagnostics,
} from './host-path-mode.js';

void test('applyPtcHostPathMode surfaces chmod failures without raw host paths', async () => {
  const missingPath = join(
    tmpdir(),
    `geulbat-ptc-mode-missing-${process.pid}-${Date.now()}`,
  );

  let caught: unknown;
  try {
    await applyPtcHostPathMode({
      path: missingPath,
      pathKind: 'ptc_test_root',
      mode: 0o700,
    });
  } catch (error: unknown) {
    caught = error;
  }

  assert.ok(caught instanceof PtcHostPathModeError);
  assert.equal(caught.pathKind, 'ptc_test_root');
  assert.equal(caught.mode, 0o700);
  assert.deepEqual(ptcHostPathModeDiagnostics(caught), {
    hostPathModeFailed: true,
    pathKind: 'ptc_test_root',
    mode: '0o700',
  });
  assert.doesNotMatch(caught.message, /geulbat-ptc-mode-missing/u);
  assert.doesNotMatch(
    JSON.stringify(ptcHostPathModeDiagnostics(caught)),
    /tmp/u,
  );
});
