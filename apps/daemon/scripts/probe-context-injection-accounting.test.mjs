import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  encodeJsonBytes,
  measurePayloadComposition,
  estimateTokens,
  ratioPct,
  deterministicFiller,
  buildToolResultOutput,
  syntheticDeferredToolDefinition,
  buildScenarioHistory,
  parseProbeOptions,
  ProbeInputError,
} from './probe-context-injection-accounting.mjs';

void test('schema version is stable', () => {
  assert.equal(SCHEMA_VERSION, 'context_injection_accounting_v2');
});

void test('encodeJsonBytes matches JSON utf8 byte length and treats undefined as 0', () => {
  assert.equal(encodeJsonBytes(undefined), 0);
  assert.equal(encodeJsonBytes([1, 2]), Buffer.byteLength('[1,2]', 'utf8'));
  assert.equal(encodeJsonBytes('한글'), Buffer.byteLength('"한글"', 'utf8'));
});

void test('measurePayloadComposition splits sources and picks the dominant one', () => {
  const payload = {
    type: 'response.create',
    model: 'm',
    instructions: 'x'.repeat(100),
    tools: [{ type: 'function', name: 'a' }],
    input: [{ role: 'user', content: 'hi' }],
  };
  const m = measurePayloadComposition(payload);
  const s = m.serializedBytesBySource;
  // Parts never exceed the whole; envelope absorbs the remainder exactly.
  assert.equal(
    s.history + s.instructions + s.toolDefinitions + s.envelope,
    m.serializedBytes,
  );
  assert.equal(m.dominantPressureSource, 'instructions');
  assert.ok(s.envelope >= 0);
});

void test('estimateTokens and ratioPct are simple deterministic arithmetic', () => {
  assert.equal(estimateTokens(4000, 4), 1000);
  assert.equal(ratioPct(1, 4), 25);
  assert.equal(ratioPct(1, 0), 0);
});

void test('deterministicFiller is reproducible and near the target size', () => {
  const a = deterministicFiller(5000);
  const b = deterministicFiller(5000);
  assert.equal(a, b);
  const bytes = Buffer.byteLength(a, 'utf8');
  assert.ok(bytes >= 5000 - 80 && bytes <= 5000 + 80, `got ${bytes}`);
});

void test('buildToolResultOutput yields valid JSON near the target size for each tool', () => {
  for (const tool of ['read_file', 'search_files', 'exec']) {
    const output = buildToolResultOutput(tool, 20000, 3);
    const parsed = JSON.parse(output); // must not throw
    assert.equal(typeof parsed, 'object');
    const bytes = Buffer.byteLength(output, 'utf8');
    assert.ok(bytes >= 18000, `${tool} too small: ${bytes}`);
  }
});

void test('syntheticDeferredToolDefinition is a deterministic function-tool schema', () => {
  const a = syntheticDeferredToolDefinition(1);
  const b = syntheticDeferredToolDefinition(1);
  assert.deepEqual(a, b);
  assert.equal(a.type, 'function');
  assert.match(a.name, /^mcp__connector_001__/);
  assert.notEqual(a.name, syntheticDeferredToolDefinition(2).name);
});

void test('buildScenarioHistory has the expected item count and kinds', () => {
  const turns = 4;
  const history = buildScenarioHistory({ turns, resultBytes: 1024 });
  // leading user + turns*(assistant, function_call, function_call_output) + trailing user
  assert.equal(history.length, 1 + turns * 3 + 1);
  assert.equal(history[0].kind, 'user');
  assert.equal(history.at(-1).kind, 'user');
  const calls = history.filter((i) => i.kind === 'function_call');
  const outputs = history.filter((i) => i.kind === 'function_call_output');
  assert.equal(calls.length, turns);
  assert.equal(outputs.length, turns);
  // each output parses and each call references an output with the same callId
  for (const call of calls) {
    assert.ok(outputs.some((o) => o.callId === call.callId));
  }
});

void test('parseProbeOptions applies defaults', () => {
  const opts = parseProbeOptions([]);
  assert.equal(opts.profile, 'root');
  assert.equal(opts.turns, 6);
  assert.equal(opts.bytesPerToken, 4);
  assert.deepEqual(opts.mcpSweep, [0, 10, 25, 50, 100]);
});

void test('parseProbeOptions parses overrides', () => {
  const opts = parseProbeOptions([
    '--profile',
    'explorer',
    '--turns',
    '3',
    '--result-bytes',
    '1024,65536',
    '--mcp-sweep',
    '0,200',
    '--bytes-per-token',
    '3.5',
    '--json',
    '--out',
    'x.json',
  ]);
  assert.equal(opts.profile, 'explorer');
  assert.equal(opts.turns, 3);
  assert.deepEqual(opts.resultBytes, [1024, 65536]);
  assert.deepEqual(opts.mcpSweep, [0, 200]);
  assert.equal(opts.bytesPerToken, 3.5);
  assert.equal(opts.json, true);
  assert.equal(opts.out, 'x.json');
});

void test('parseProbeOptions rejects bad input', () => {
  assert.throws(
    () => parseProbeOptions(['--profile', 'bogus']),
    ProbeInputError,
  );
  assert.throws(() => parseProbeOptions(['--turns', '0']), ProbeInputError);
  assert.throws(
    () => parseProbeOptions(['--bytes-per-token', '0']),
    ProbeInputError,
  );
  assert.throws(
    () => parseProbeOptions(['--result-bytes', 'x']),
    ProbeInputError,
  );
  assert.throws(() => parseProbeOptions(['--unknown']), ProbeInputError);
  assert.throws(() => parseProbeOptions(['--out']), ProbeInputError);
});
