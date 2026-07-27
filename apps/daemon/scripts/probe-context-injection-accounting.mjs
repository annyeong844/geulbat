#!/usr/bin/env node
// Deterministic context-injection accounting probe.
//
// Measures how many BYTES each part of a provider request costs, exercising the
// daemon's real request-assembly and tool-result-offload code paths — no
// provider, no network, no clock, no randomness. Bytes are the daemon's native
// budgeting unit (see memory/compaction-loop.ts `estimateInputTokens`, which
// converts request bytes to tokens with a per-model calibration learned from
// real usage; there is no built-in ratio). Token figures here are a clearly
// labelled estimate at a configurable bytes/token rate.
//
// Four sections:
//   1. Whole-request composition — {history, instructions, toolDefinitions,
//      envelope}, the same split the daemon computes in
//      transport/responses-websocket.ts `measureResponsesRequest`.
//   2. Tool-call injection — directHot schemas actually injected vs a
//      full-injection counterfactual, and how deferral keeps the injected cost
//      flat as the deferred pool (MCP tools) grows.
//   3. Tool-result injection — full output bytes vs model-visible bytes after
//      the real `maybeOffloadToolResult` offload/projection.
//   4. Compaction targeting — deterministic history-growth and prefix/tail
//      accounting (realized summary size needs a live model; out of scope here).
//
// Usage:
//   node --import tsx apps/daemon/scripts/probe-context-injection-accounting.mjs [options]
//   node --import tsx apps/daemon/scripts/probe-context-injection-accounting.mjs --json --out result.json
//
// Options (all optional; deterministic defaults):
//   --profile <root|explorer|worker>   system prompt profile           (root)
//   --turns <n>                        tool-using turns in the scenario (6)
//   --result-bytes <csv>               tool-result sizes for section 3  (2048,16384,131072,524288)
//   --mcp-sweep <csv>                  deferred MCP tool counts         (0,10,25,50,100)
//   --keep-recent-turns <n>            retained tail for section 4      (2)
//   --bytes-per-token <f>              token estimate rate              (4)
//   --json                             print machine JSON only
//   --out <path>                       also write the JSON artifact
//   --help

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCHEMA_VERSION = 'context_injection_accounting_v2';

// The inline byte budget above which a tool result is offloaded behind a
// reference (tool-output-offload.ts DEFAULT_TOOL_OUTPUT_INLINE_MAX_BYTES).
const INLINE_MAX_BYTES = 40 * 1024;

// ---------------------------------------------------------------------------
// Real daemon modules (resolved relative to this file, cwd-independent).
// ---------------------------------------------------------------------------
function srcUrl(relative) {
  return new URL(`../src/${relative}`, import.meta.url).href;
}

async function loadDaemonModules() {
  const [
    prompt,
    codex,
    wire,
    catalog,
    toolDefs,
    runContext,
    offload,
    threadId,
  ] = await Promise.all([
    import(srcUrl('daemon/agent/prompt/build-system-prompt.ts')),
    import(srcUrl('daemon/llm/provider/codex-request.ts')),
    import(srcUrl('daemon/llm/provider/transport/responses-wire-input.ts')),
    import(srcUrl('daemon/tools/builtin/catalog.ts')),
    import(srcUrl('daemon/agent/loop-tool-definitions.ts')),
    import(srcUrl('daemon/run-context.ts')),
    import(srcUrl('daemon/agent/tool-output-offload.ts')),
    import(srcUrl('test-support/thread-id.ts')),
  ]);
  return {
    buildSystemPrompt: prompt.buildSystemPrompt,
    buildResponsesRequestBody: codex.buildResponsesRequestBody,
    buildResponseWireInput: wire.buildResponseWireInput,
    measureResponseWireInputBytes: wire.measureResponseWireInputBytes,
    measureAppendBytes: wire.measureResponseWireFunctionCallOutputAppendBytes,
    createBuiltinToolRegistryStore: catalog.createBuiltinToolRegistryStore,
    createAgentLoopToolDefinitionPort:
      toolDefs.createAgentLoopToolDefinitionPort,
    createRunContext: runContext.createRunContext,
    maybeOffloadToolResult: offload.maybeOffloadToolResult,
    resolveToolOutputProjectionPolicyFromEnv:
      offload.resolveToolOutputProjectionPolicyFromEnv,
    testThreadId: threadId.testThreadId,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the unit test).
// ---------------------------------------------------------------------------

/** Byte length of the JSON serialization, matching `measureSerializedValue`. */
export function encodeJsonBytes(value) {
  return value === undefined
    ? 0
    : Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Faithful replica of transport/responses-websocket.ts `measureResponsesRequest`:
 * split a `response.create` payload into per-source byte counts.
 */
export function measurePayloadComposition(payload) {
  const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  const history = encodeJsonBytes(payload.input);
  const instructions = encodeJsonBytes(payload.instructions);
  const toolDefinitions = encodeJsonBytes(payload.tools);
  const envelope = Math.max(
    0,
    serializedBytes - history - instructions - toolDefinitions,
  );
  const bySource = { history, instructions, toolDefinitions, envelope };
  const dominantPressureSource = Object.entries({
    history,
    instructions,
    tool_definitions: toolDefinitions,
    envelope,
  }).reduce((top, entry) => (entry[1] > top[1] ? entry : top))[0];
  return {
    serializedBytes,
    dominantPressureSource,
    serializedBytesBySource: bySource,
  };
}

/** Estimated tokens at a configurable rate. Labelled as an estimate everywhere. */
export function estimateTokens(bytes, bytesPerToken) {
  return Math.round(bytes / bytesPerToken);
}

export function ratioPct(part, whole) {
  return whole === 0 ? 0 : (part / whole) * 100;
}

/**
 * Deterministic filler that expands to roughly `targetBytes` UTF-8 bytes. No
 * randomness — reproducible across runs and machines.
 */
export function deterministicFiller(targetBytes) {
  const unit =
    'export function handler(request, response) { return response.ok(request.id); } ';
  const repeats = Math.max(1, Math.ceil(targetBytes / unit.length));
  return unit.repeat(repeats).slice(0, Math.max(1, targetBytes));
}

/**
 * Build a realistic tool-result output string of about `targetBytes` bytes for
 * the given projection-bearing tool. Shapes mirror what each tool really emits.
 */
export function buildToolResultOutput(toolName, targetBytes, index) {
  if (toolName === 'search_files') {
    const results = [];
    let bytes = 0;
    let line = 1;
    while (bytes < targetBytes) {
      const row = {
        path: `src/module-${index}/file-${results.length}.ts`,
        line,
        text: deterministicFiller(80),
      };
      results.push(row);
      bytes += JSON.stringify(row).length + 1;
      line += 7;
    }
    return JSON.stringify({
      root: 'workspace',
      path: '.',
      query: 'handler',
      total: results.length,
      results,
    });
  }
  if (toolName === 'exec') {
    return JSON.stringify({
      kind: 'execute_code_cell_terminal_result',
      status: 'ok',
      cellId: `cell-${index}`,
      exitCode: 0,
      stdout: deterministicFiller(targetBytes),
    });
  }
  // read_file and the generic case: a file-content envelope.
  return JSON.stringify({
    ok: true,
    path: `src/generated/file-${index}.ts`,
    content: deterministicFiller(targetBytes),
  });
}

/**
 * A representative deferred (e.g. MCP) tool schema, used only as a counterfactual
 * for "what if every deferred tool were injected". Size is deterministic.
 */
export function syntheticDeferredToolDefinition(index) {
  return {
    type: 'function',
    name: `mcp__connector_${String(index).padStart(3, '0')}__perform_action`,
    description:
      'Perform a connector action against an external system. Validates the ' +
      'target resource, applies the requested mutation, and returns the ' +
      'resulting record together with any server-side warnings.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          description: 'Target resource identifier.',
        },
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'read'],
          description: 'Mutation to apply.',
        },
        payload: {
          type: 'object',
          description: 'Action-specific fields.',
          additionalProperties: true,
        },
        dryRun: { type: 'boolean', description: 'Validate without applying.' },
      },
      required: ['resourceId', 'action'],
      additionalProperties: false,
    },
    strict: true,
  };
}

/** Build a deterministic mid-conversation history with inline tool results. */
export function buildScenarioHistory({ turns, resultBytes }) {
  const history = [
    {
      kind: 'user',
      text: 'Refactor the request pipeline and keep the tool contracts intact.',
    },
  ];
  const toolCycle = ['read_file', 'search_files', 'exec'];
  for (let turn = 0; turn < turns; turn += 1) {
    const toolName = toolCycle[turn % toolCycle.length];
    const callId = `call_${turn}`;
    history.push({
      kind: 'assistant',
      phase: 'commentary',
      text: `Turn ${turn}: inspecting ${toolName} output before the next edit.`,
    });
    history.push({
      kind: 'function_call',
      id: `fc_${turn}`,
      callId,
      name: toolName,
      arguments: JSON.stringify({ path: `src/module-${turn}` }),
    });
    history.push({
      kind: 'function_call_output',
      callId,
      output: buildToolResultOutput(toolName, resultBytes, turn),
    });
  }
  history.push({
    kind: 'user',
    text: 'Now summarize what changed and confirm the contracts still hold.',
  });
  return history;
}

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------
export class ProbeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeInputError';
  }
}

function parseCsvInts(raw, label) {
  const parts = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (parts.length === 0)
    throw new ProbeInputError(`${label} needs at least one value`);
  return parts.map((value) => {
    if (!/^\d+$/.test(value))
      throw new ProbeInputError(`${label} must be integers: ${value}`);
    return Number(value);
  });
}

export function parseProbeOptions(argv) {
  const options = {
    profile: 'root',
    turns: 6,
    resultBytes: [2048, 16384, 131072, 524288],
    mcpSweep: [0, 10, 25, 50, 100],
    keepRecentTurns: 2,
    bytesPerToken: 4,
    json: false,
    out: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined)
        throw new ProbeInputError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--help':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--profile': {
        const value = next();
        if (!['root', 'explorer', 'worker'].includes(value)) {
          throw new ProbeInputError(`--profile must be root|explorer|worker`);
        }
        options.profile = value;
        break;
      }
      case '--turns':
        options.turns = Number(next());
        break;
      case '--keep-recent-turns':
        options.keepRecentTurns = Number(next());
        break;
      case '--bytes-per-token':
        options.bytesPerToken = Number(next());
        break;
      case '--result-bytes':
        options.resultBytes = parseCsvInts(next(), '--result-bytes');
        break;
      case '--mcp-sweep':
        options.mcpSweep = parseCsvInts(next(), '--mcp-sweep');
        break;
      case '--out':
        options.out = next();
        break;
      default:
        throw new ProbeInputError(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.turns) || options.turns < 1) {
    throw new ProbeInputError('--turns must be a positive integer');
  }
  if (
    !Number.isInteger(options.keepRecentTurns) ||
    options.keepRecentTurns < 0
  ) {
    throw new ProbeInputError(
      '--keep-recent-turns must be a non-negative integer',
    );
  }
  if (!(options.bytesPerToken > 0)) {
    throw new ProbeInputError('--bytes-per-token must be > 0');
  }
  return options;
}

// ---------------------------------------------------------------------------
// Section 1 — whole-request composition.
// ---------------------------------------------------------------------------
async function measureWholeRequest(mods, opts, directDefs, history) {
  const systemPrompt = mods.buildSystemPrompt({
    profile: opts.profile,
    computerSessionAvailable: false,
  });
  const body = mods.buildResponsesRequestBody(
    {
      systemPrompt,
      tools: directDefs,
      providerSessionId: 'probe-session',
      providerRequestOptions: {
        model: 'gpt-5-codex',
        serviceTier: 'default',
        text: { verbosity: 'medium' },
        reasoning: { effort: 'high', summary: 'auto' },
      },
    },
    { wire: { prompt_cache_key: 'probe-key', session_id: 'probe-session' } },
  );
  const payload = {
    type: 'response.create',
    ...body,
    input: mods.buildResponseWireInput(history),
  };
  const composition = measurePayloadComposition(payload);
  return { systemPrompt, composition };
}

// ---------------------------------------------------------------------------
// Section 2 — tool-call injection efficiency.
// ---------------------------------------------------------------------------
function measureToolCallInjection(mods, opts) {
  const registry = mods.createBuiltinToolRegistryStore();
  const allDefs = registry.buildToolDefinitions();
  const directPort = mods.createAgentLoopToolDefinitionPort(registry);
  const directDefs = directPort.buildToolDefinitions({});
  const directNames = new Set(directDefs.map((definition) => definition.name));

  const deferredNames = allDefs
    .filter((definition) => !directNames.has(definition.name))
    .map((definition) => definition.name);

  const injectedBytes = encodeJsonBytes(directDefs);
  const allBuiltinBytes = encodeJsonBytes(allDefs);

  const perTool = directDefs
    .map((d) => ({ name: d.name, bytes: encodeJsonBytes(d) }))
    .sort((a, b) => b.bytes - a.bytes);

  const mcpTemplateBytes = encodeJsonBytes(syntheticDeferredToolDefinition(0));
  const sweep = opts.mcpSweep.map((count) => {
    const synthetic = Array.from({ length: count }, (_, i) =>
      syntheticDeferredToolDefinition(i),
    );
    return {
      deferredMcpTools: count,
      injectedBytes, // constant — deferred tools never enter the request
      injectAllBytes: encodeJsonBytes([...directDefs, ...synthetic]),
    };
  });

  return {
    totalRegisteredTools: allDefs.length,
    directToolsInjected: directDefs.length,
    deferredBuiltins: deferredNames,
    injectedBytes,
    allBuiltinBytes,
    savedVsAllBuiltinsBytes: allBuiltinBytes - injectedBytes,
    heaviestInjectedTools: perTool.slice(0, 8),
    mcpTemplateBytes,
    deferralSweep: sweep,
    directDefs,
  };
}

// ---------------------------------------------------------------------------
// Section 3 — tool-result injection efficiency.
// ---------------------------------------------------------------------------
async function measureToolResultInjection(mods, opts, stateRoot) {
  const registry = mods.createBuiltinToolRegistryStore();
  const policy = mods.resolveToolOutputProjectionPolicyFromEnv({});
  const threadId = mods.testThreadId(7);
  const runId = 'run-context-injection-probe';

  const cases = [];
  const toolNames = ['read_file', 'search_files', 'exec'];
  for (const toolName of toolNames) {
    const resultProjection = registry.getToolMeta(toolName)?.resultProjection;
    if (resultProjection === undefined) continue;
    for (const targetBytes of opts.resultBytes) {
      const callId = `call-${toolName}-${targetBytes}`;
      const output = buildToolResultOutput(toolName, targetBytes, targetBytes);
      const fullToolResult = { ok: true, output };
      const measureModelVisibleResultBytes = (candidate) =>
        mods.measureAppendBytes({
          kind: 'function_call_output',
          callId,
          output: candidate.ok
            ? candidate.output
            : JSON.stringify({ ok: false, error: candidate.error }),
        });

      const fullVisibleBytes = measureModelVisibleResultBytes(fullToolResult);
      const returned = await mods.maybeOffloadToolResult({
        functionCall: {
          id: `fc-${callId}`,
          callId,
          name: toolName,
          arguments: '{}',
        },
        runContext: mods.createRunContext({ threadId, stateRoot }),
        runId,
        resultProjection,
        projectionPolicy: policy,
        measureModelVisibleResultBytes,
        toolResult: fullToolResult,
      });
      const visibleBytes = measureModelVisibleResultBytes(returned);
      const offloaded = returned.output !== output;
      cases.push({
        tool: toolName,
        fullOutputBytes: Buffer.byteLength(output, 'utf8'),
        fullVisibleBytes,
        modelVisibleBytes: visibleBytes,
        offloaded,
        reductionPct: ratioPct(
          fullVisibleBytes - visibleBytes,
          fullVisibleBytes,
        ),
      });
    }
  }
  const inlineThresholdBytes = policy.inlineMaxBytes;
  return { inlineThresholdBytes, cases };
}

// ---------------------------------------------------------------------------
// Section 4 — compaction targeting accounting (deterministic).
// ---------------------------------------------------------------------------
function measureCompactionAccounting(mods, opts, history) {
  const totalHistoryBytes = mods.measureResponseWireInputBytes(history);

  // Keep-recent split: the trailing `keepRecentTurns` tool cycles plus the final
  // user turn are retained; everything older is the compactible prefix. This is
  // the accounting compaction targets — the realized summary size depends on a
  // live model and is out of scope for a deterministic probe.
  const tailItemCount = opts.keepRecentTurns * 3 + 1; // per turn: assistant+call+output
  const splitAt = Math.max(1, history.length - tailItemCount);
  const prefix = history.slice(0, splitAt);
  const tail = history.slice(splitAt);
  const prefixBytes = mods.measureResponseWireInputBytes(prefix);
  const tailBytes = mods.measureResponseWireInputBytes(tail);

  return {
    turns: opts.turns,
    keepRecentTurns: opts.keepRecentTurns,
    totalHistoryBytes,
    compactiblePrefixBytes: prefixBytes,
    retainedTailBytes: tailBytes,
    prefixSharePct: ratioPct(prefixBytes, totalHistoryBytes),
  };
}

// ---------------------------------------------------------------------------
// Report rendering.
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
function fmtInt(n) {
  return n.toLocaleString('en-US');
}
function pad(s, width) {
  return String(s).padEnd(width);
}
function padL(s, width) {
  return String(s).padStart(width);
}

function renderReport(result) {
  const tok = (bytes) => estimateTokens(bytes, result.params.bytesPerToken);
  const L = [];
  L.push('='.repeat(78));
  L.push('CONTEXT-INJECTION ACCOUNTING  ' + `(${SCHEMA_VERSION})`);
  L.push('='.repeat(78));
  L.push(
    `profile=${result.params.profile}  turns=${result.params.turns}  ` +
      `bytes/token=${result.params.bytesPerToken} (token figures are estimates)`,
  );
  L.push('');

  // Section 1
  const c = result.wholeRequest.composition;
  const s = c.serializedBytesBySource;
  L.push('1. WHOLE-REQUEST COMPOSITION  (one mid-conversation request)');
  L.push('-'.repeat(78));
  const rows = [
    ['instructions (system prompt)', s.instructions],
    ['tool definitions (injected)', s.toolDefinitions],
    ['history (turns + tool results)', s.history],
    ['envelope (model, flags, cache key)', s.envelope],
  ];
  for (const [label, bytes] of rows) {
    L.push(
      `  ${pad(label, 36)} ${padL(fmtBytes(bytes), 11)}  ` +
        `${padL(ratioPct(bytes, c.serializedBytes).toFixed(1) + '%', 6)}  ` +
        `~${padL(fmtInt(tok(bytes)), 8)} tok`,
    );
  }
  L.push(
    `  ${pad('TOTAL', 36)} ${padL(fmtBytes(c.serializedBytes), 11)}  ` +
      `${padL('100.0%', 6)}  ~${padL(fmtInt(tok(c.serializedBytes)), 8)} tok`,
  );
  L.push(`  dominant pressure source: ${c.dominantPressureSource}`);
  L.push('');

  // Section 2
  const t = result.toolCall;
  L.push('2. TOOL-CALL INJECTION  (도구 호출부)');
  L.push('-'.repeat(78));
  L.push(
    `  registered tools: ${t.totalRegisteredTools}   ` +
      `injected (root direct): ${t.directToolsInjected}   ` +
      `deferred builtins: ${t.deferredBuiltins.join(', ')}`,
  );
  L.push(
    `  injected schema bytes: ${fmtBytes(t.injectedBytes)}  ` +
      `(~${fmtInt(tok(t.injectedBytes))} tok)   ` +
      `all-builtins: ${fmtBytes(t.allBuiltinBytes)}`,
  );
  L.push('  heaviest injected tools:');
  for (const tool of t.heaviestInjectedTools) {
    L.push(`    ${pad(tool.name, 22)} ${padL(fmtBytes(tool.bytes), 10)}`);
  }
  L.push('');
  L.push(
    `  deferral scaling (synthetic MCP schema ~${fmtBytes(t.mcpTemplateBytes)} each):`,
  );
  L.push(
    `    ${pad('deferred MCP tools', 20)} ${padL('injected', 12)} ` +
      `${padL('if inject-all', 14)} ${padL('saved', 12)}`,
  );
  for (const row of t.deferralSweep) {
    const saved = row.injectAllBytes - row.injectedBytes;
    L.push(
      `    ${padL(row.deferredMcpTools, 20)} ${padL(fmtBytes(row.injectedBytes), 12)} ` +
        `${padL(fmtBytes(row.injectAllBytes), 14)} ${padL(fmtBytes(saved), 12)}`,
    );
  }
  L.push(
    '  → injected cost is O(root-direct)+const, flat as the deferred pool grows.',
  );
  L.push('');

  // Section 3
  const r = result.toolResult;
  L.push('3. TOOL-RESULT INJECTION  (도구 result 주입)');
  L.push('-'.repeat(78));
  L.push(
    `  inline threshold: ${fmtBytes(r.inlineThresholdBytes)} (offload above this)`,
  );
  L.push(
    `    ${pad('tool', 12)} ${padL('full output', 12)} ${padL('model-visible', 14)} ` +
      `${padL('reduction', 10)} ${padL('offloaded', 10)}`,
  );
  for (const row of r.cases) {
    L.push(
      `    ${pad(row.tool, 12)} ${padL(fmtBytes(row.fullVisibleBytes), 12)} ` +
        `${padL(fmtBytes(row.modelVisibleBytes), 14)} ` +
        `${padL(row.reductionPct.toFixed(1) + '%', 10)} ${padL(row.offloaded ? 'yes' : 'no', 10)}`,
    );
  }
  L.push('');

  // Section 4
  const k = result.compaction;
  L.push('4. COMPACTION TARGETING  (deterministic accounting)');
  L.push('-'.repeat(78));
  L.push(
    `  history: ${fmtBytes(k.totalHistoryBytes)} (~${fmtInt(tok(k.totalHistoryBytes))} tok)` +
      `   keep-recent turns: ${k.keepRecentTurns}`,
  );
  L.push(
    `  compactible prefix: ${fmtBytes(k.compactiblePrefixBytes)} ` +
      `(${k.prefixSharePct.toFixed(1)}%)   retained tail: ${fmtBytes(k.retainedTailBytes)}`,
  );
  L.push('  (realized summary size needs a live model — not measured here)');
  L.push('='.repeat(78));
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const HELP = `Deterministic context-injection accounting probe.

  node --import tsx apps/daemon/scripts/probe-context-injection-accounting.mjs [options]

Options:
  --profile <root|explorer|worker>   system prompt profile           (root)
  --turns <n>                        tool-using turns in the scenario (6)
  --result-bytes <csv>               tool-result sizes for section 3  (2048,16384,131072,524288)
  --mcp-sweep <csv>                  deferred MCP tool counts         (0,10,25,50,100)
  --keep-recent-turns <n>            retained tail for section 4      (2)
  --bytes-per-token <f>              token estimate rate              (4)
  --json                             print machine JSON only
  --out <path>                       also write the JSON artifact
  --help`;

async function runProbe(opts) {
  const mods = await loadDaemonModules();
  const history = buildScenarioHistory({
    turns: opts.turns,
    resultBytes: Math.min(...opts.resultBytes),
  });
  const toolCall = measureToolCallInjection(mods, opts);
  const wholeRequest = await measureWholeRequest(
    mods,
    opts,
    toolCall.directDefs,
    history,
  );
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-ctx-injection-'));
  let toolResult;
  try {
    toolResult = await measureToolResultInjection(mods, opts, stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
  const compaction = measureCompactionAccounting(mods, opts, history);

  // Drop the bulky direct definitions from the serialized report.
  const { directDefs, ...toolCallReport } = toolCall;
  void directDefs;
  return {
    schemaVersion: SCHEMA_VERSION,
    params: {
      profile: opts.profile,
      turns: opts.turns,
      resultBytes: opts.resultBytes,
      mcpSweep: opts.mcpSweep,
      keepRecentTurns: opts.keepRecentTurns,
      bytesPerToken: opts.bytesPerToken,
      inlineMaxBytes: INLINE_MAX_BYTES,
    },
    wholeRequest: { composition: wholeRequest.composition },
    toolCall: toolCallReport,
    toolResult,
    compaction,
  };
}

async function main(argv) {
  let opts;
  try {
    opts = parseProbeOptions(argv);
  } catch (error) {
    if (error instanceof ProbeInputError) {
      process.stderr.write(`${error.message}\n\n${HELP}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const result = await runProbe(opts);
  if (opts.out !== undefined) {
    await writeFile(opts.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(result)}\n`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
