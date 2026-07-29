import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderNativeCompactionEvidenceRef } from '../contract.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import {
  areProviderNativeCompactionEvidencePagesValid,
  collectProviderNativeCompactionEvidence,
  selectProviderNativeCompactionEvidenceRef,
  type ProviderNativeCompactionExpandedEvidencePage,
} from './provider-native-compaction-evidence.js';

void test('collectProviderNativeCompactionEvidence projects unique tool and command output metadata', () => {
  const successfulOutputRef = 'tool-output:thread/run/call-search';
  const failedOutputRef = 'tool-output:thread/run/call-read';
  const commandOutputRef = 'command-output:thread/command';
  const historyPrefix: HistoryItem[] = [
    {
      kind: 'function_call',
      id: 'fc-search',
      callId: 'call-search',
      name: 'search_files',
      arguments: '{"query":"owner"}',
    },
    {
      kind: 'function_call_output',
      callId: 'call-search',
      output: JSON.stringify({
        ok: true,
        outputRef: successfulOutputRef,
        fullOutputBytes: 64_000,
      }),
    },
    {
      kind: 'function_call',
      id: 'fc-read',
      callId: 'call-read',
      name: 'read_file',
      arguments: '{"path":"missing.txt"}',
    },
    {
      kind: 'function_call_output',
      callId: 'call-read',
      output: JSON.stringify({
        ok: false,
        tool: 'read_file',
        outputRef: failedOutputRef,
        fullOutputBytes: 512,
      }),
    },
    {
      kind: 'function_call',
      id: 'fc-command',
      callId: 'call-command',
      name: 'exec_command',
      arguments: '{"cmd":"long-running-command"}',
    },
    {
      kind: 'function_call_output',
      callId: 'call-command',
      output: JSON.stringify({
        status: 'exit',
        snapshot: {
          outputRef: commandOutputRef,
          stdoutBytes: 120,
          stderrBytes: 4,
        },
      }),
    },
    {
      kind: 'function_call_output',
      callId: 'call-duplicate-ref',
      output: JSON.stringify({
        ok: true,
        tool: 'search_files',
        outputRef: successfulOutputRef,
        fullOutputBytes: 64_000,
      }),
    },
    {
      kind: 'function_call_output',
      callId: 'call-invalid',
      output: '{"outputRef":"tool-output:thread/run/invalid"}',
    },
  ];

  assert.deepEqual(collectProviderNativeCompactionEvidence(historyPrefix), [
    {
      callId: 'call-search',
      toolName: 'search_files',
      outcome: 'success',
      fullOutputBytes: 64_000,
      outputRef: successfulOutputRef,
    },
    {
      callId: 'call-read',
      toolName: 'read_file',
      outcome: 'failure',
      fullOutputBytes: 512,
      outputRef: failedOutputRef,
    },
    {
      callId: 'call-command',
      toolName: 'exec_command',
      outcome: 'unknown',
      fullOutputBytes: 124,
      outputRef: commandOutputRef,
    },
  ]);
});

void test('selectProviderNativeCompactionEvidenceRef requires one exact call and evidence identity', () => {
  const historyPrefix: HistoryItem[] = [
    {
      kind: 'function_call',
      id: 'fc-search',
      callId: 'call-search',
      name: 'search_files',
      arguments: '{"query":"owner"}',
    },
    {
      kind: 'function_call',
      id: 'fc-ambiguous',
      callId: 'call-ambiguous',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    },
    {
      kind: 'backend_item',
      data: {
        type: 'function_call',
        id: 'fc-ambiguous-native',
        call_id: 'call-ambiguous',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
    },
    {
      kind: 'function_call',
      id: 'fc-no-evidence',
      callId: 'call-no-evidence',
      name: 'read_file',
      arguments: '{"path":"none.txt"}',
    },
    {
      kind: 'function_call',
      id: 'fc-duplicate-evidence',
      callId: 'call-duplicate-evidence',
      name: 'read_file',
      arguments: '{"path":"duplicate.txt"}',
    },
    {
      kind: 'function_call',
      id: 'fc-wrong-evidence',
      callId: 'call-wrong-evidence',
      name: 'read_file',
      arguments: '{"path":"wrong.txt"}',
    },
  ];
  const selectedEvidence: ProviderNativeCompactionEvidenceRef = {
    callId: 'call-search',
    toolName: 'search_files',
    outcome: 'success',
    fullOutputBytes: 64_000,
    outputRef: 'tool-output:thread/run/call-search',
  };
  const evidence: ProviderNativeCompactionEvidenceRef[] = [
    selectedEvidence,
    {
      callId: 'call-ambiguous',
      toolName: 'read_file',
      outcome: 'success',
      fullOutputBytes: 10,
      outputRef: 'tool-output:thread/run/call-ambiguous',
    },
    {
      callId: 'call-duplicate-evidence',
      toolName: 'read_file',
      outcome: 'success',
      fullOutputBytes: 10,
      outputRef: 'tool-output:thread/run/call-duplicate-evidence-a',
    },
    {
      callId: 'call-duplicate-evidence',
      toolName: 'read_file',
      outcome: 'success',
      fullOutputBytes: 11,
      outputRef: 'tool-output:thread/run/call-duplicate-evidence-b',
    },
    {
      callId: 'call-wrong-evidence',
      toolName: 'search_files',
      outcome: 'success',
      fullOutputBytes: 12,
      outputRef: 'tool-output:thread/run/call-wrong-evidence',
    },
  ];
  const select = (callId: string, toolName: string, argumentsJson: string) =>
    selectProviderNativeCompactionEvidenceRef({
      evidence,
      historyPrefix,
      target: { callId, toolName, arguments: argumentsJson },
    });

  assert.deepEqual(select('call-search', 'search_files', '{"query":"owner"}'), {
    kind: 'selected',
    evidence: selectedEvidence,
  });
  assert.deepEqual(
    select('call-missing', 'search_files', '{"query":"owner"}'),
    { kind: 'failed', reason: 'target_call_not_found' },
  );
  assert.deepEqual(select('call-ambiguous', 'read_file', '{"path":"a.txt"}'), {
    kind: 'failed',
    reason: 'target_call_ambiguous',
  });
  assert.deepEqual(
    select('call-search', 'search_files', '{"query":"different"}'),
    { kind: 'failed', reason: 'target_call_identity_mismatch' },
  );
  assert.deepEqual(
    select('call-no-evidence', 'read_file', '{"path":"none.txt"}'),
    { kind: 'failed', reason: 'target_evidence_not_found' },
  );
  assert.deepEqual(
    select('call-duplicate-evidence', 'read_file', '{"path":"duplicate.txt"}'),
    { kind: 'failed', reason: 'target_evidence_ambiguous' },
  );
  assert.deepEqual(
    select('call-wrong-evidence', 'read_file', '{"path":"wrong.txt"}'),
    { kind: 'failed', reason: 'target_evidence_identity_mismatch' },
  );
});

void test('areProviderNativeCompactionEvidencePagesValid accepts only unique bounded pages for known refs', () => {
  const outputRef = 'tool-output:thread/run/call-search';
  const evidence: ProviderNativeCompactionEvidenceRef[] = [
    {
      callId: 'call-search',
      toolName: 'search_files',
      outcome: 'success',
      fullOutputBytes: 64_000,
      outputRef,
    },
  ];
  const validPage: ProviderNativeCompactionExpandedEvidencePage = {
    outputRef,
    offset: 10,
    limit: 20,
    endOffset: 15,
    totalChars: 100,
    content: 'owner',
  };

  assert.equal(
    areProviderNativeCompactionEvidencePagesValid([validPage], evidence),
    true,
  );
  assert.equal(
    areProviderNativeCompactionEvidencePagesValid(
      [{ ...validPage, outputRef: 'tool-output:thread/run/unknown' }],
      evidence,
    ),
    false,
  );
  assert.equal(
    areProviderNativeCompactionEvidencePagesValid(
      [validPage, validPage],
      evidence,
    ),
    false,
  );
  assert.equal(
    areProviderNativeCompactionEvidencePagesValid(
      [{ ...validPage, offset: -1 }],
      evidence,
    ),
    false,
  );
  assert.equal(
    areProviderNativeCompactionEvidencePagesValid(
      [{ ...validPage, endOffset: 31 }],
      evidence,
    ),
    false,
  );
  assert.equal(
    areProviderNativeCompactionEvidencePagesValid(
      [{ ...validPage, content: 'too long' }],
      evidence,
    ),
    false,
  );
  assert.equal(
    areProviderNativeCompactionEvidencePagesValid(
      [{ ...validPage, totalChars: 14 }],
      evidence,
    ),
    false,
  );
});
