import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const SCRIPT_PATH = new URL(
  './probe-provider-failover-fault-lab.mjs',
  import.meta.url,
);

async function runFaultLab(outputPath) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', SCRIPT_PATH.pathname, '--output', outputPath],
    {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  assert.equal(
    exitCode,
    0,
    `fault lab failed\nstdout:\n${Buffer.concat(stdout)}\nstderr:\n${Buffer.concat(stderr)}`,
  );
}

void test('provider failover fault lab records safe bidirectional gate evidence', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'geulbat-p8-lab-test-'));
  const outputPath = join(temporaryRoot, 'report.json');
  try {
    await runFaultLab(outputPath);
    const reportText = await readFile(outputPath, 'utf8');
    const report = JSON.parse(reportText);

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.executionMode, 'injected_non_network');
    assert.equal(report.summary.totalCaseCount, 88);
    assert.equal(report.summary.currentComposition.caseCount, 44);
    assert.equal(report.summary.candidateTerminalQuarantine.caseCount, 44);
    assert.equal(
      report.summary.candidateTerminalQuarantine.expectedEligibleCaseCount,
      6,
    );
    assert.equal(
      report.summary.candidateTerminalQuarantine.actualEligibleCaseCount,
      6,
    );
    assert.equal(
      report.summary.candidateTerminalQuarantine.recoveredEligibleCaseCount,
      6,
    );
    assert.equal(
      report.summary.candidateTerminalQuarantine.ineligibleTargetRequestCount,
      0,
    );
    assert.equal(
      report.summary.candidateTerminalQuarantine.duplicateSideEffectCount,
      0,
    );
    assert.equal(
      report.summary.candidateTerminalQuarantine.historyLossCount,
      0,
    );

    const eligible = report.cases.find(
      (entry) =>
        entry.id ===
        'candidate_terminal_quarantine:gpt_to_grok:connection_lost',
    );
    assert.equal(eligible.actualEligible, true);
    assert.equal(eligible.targetRequestCount, 1);
    assert.equal(eligible.historyMeaningPreserved, true);
    assert.equal(eligible.providerBoundHistoryRemoved, true);
    assert.equal(eligible.sourceTerminalEventCountBeforeTarget, 0);
    assert.equal(eligible.quarantinedSourceTerminalEventCount, 1);
    assert.equal(eligible.sourceTerminalSuppressed, true);

    const partial = report.cases.find(
      (entry) =>
        entry.id ===
        'candidate_terminal_quarantine:grok_to_gpt:partial_text_then_connection_lost',
    );
    assert.equal(partial.actualEligible, false);
    assert.equal(partial.admissionReason, 'attempt_semantic_output_observed');
    assert.equal(partial.targetRequestCount, 0);

    const mutation = report.cases.find(
      (entry) =>
        entry.id ===
        'candidate_terminal_quarantine:gpt_to_grok:mutation_tool_then_connection_lost',
    );
    assert.equal(mutation.actualEligible, false);
    assert.equal(mutation.toolInvocationCount, 1);
    assert.equal(mutation.mutationCommitCount, 1);
    assert.equal(mutation.duplicateSideEffectCount, 0);
    assert.equal(mutation.targetRequestCount, 0);

    assert.equal(report.summary.currentComposition.terminalEventLeakCount, 6);
    assert.equal(report.summary.currentComposition.gatePassed, false);
    assert.equal(
      report.summary.candidateTerminalQuarantine.terminalEventLeakCount,
      0,
    );
    assert.equal(report.summary.candidateTerminalQuarantine.gatePassed, true);
    assert.equal(report.summary.terminalQuarantineArmPassed, true);
    assert.equal(report.summary.restartExactlyOnceProvable, false);
    assert.equal(report.summary.p8cCandidateGatePassed, false);
    assert.equal(report.summary.productPathObserved, false);
    assert.equal(report.restartIdentityProbes.length, 2);
    for (const probe of report.restartIdentityProbes) {
      assert.equal(probe.checkpointRoundTrip, true);
      assert.equal(probe.sourceSelectionRecovered, true);
      assert.equal(probe.targetSelectionRecovered, false);
      assert.equal(probe.transitionReasonRecovered, false);
      assert.equal(probe.transitionIdentityRecovered, false);
      assert.equal(probe.transitionMutationOwnerObserved, false);
      assert.equal(probe.exactlyOnceProvable, false);
    }
    assert.equal(reportText.includes('P8_FAULT_LAB_'), false);
    assert.equal(reportText.includes('encrypted_content'), false);
    assert.equal(reportText.includes('accessToken'), false);
    assert.equal(reportText.includes('reasoning'), false);
    assert.equal(reportText.includes('toolResult'), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
