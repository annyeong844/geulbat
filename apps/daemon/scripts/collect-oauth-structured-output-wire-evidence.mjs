const argv = process.argv.slice(2);
const isPreflight = argv.includes('--preflight');
const experimentFlagIndex = argv.indexOf('--experiment');
const experimentId =
  experimentFlagIndex === -1 ? undefined : argv[experimentFlagIndex + 1];

if (experimentFlagIndex !== -1 && !experimentId) {
  throw new Error('--experiment requires an experiment id');
}

const outputPath = process.env.GEULBAT_OAUTH_WIRE_DISCOVERY_OUTPUT;

const { execFile } = await import('node:child_process');
const { mkdir, readFile, writeFile } = await import('node:fs/promises');
const { dirname, join } = await import('node:path');
const { randomUUID } = await import('node:crypto');
const { promisify } = await import('node:util');
const { fileURLToPath } = await import('node:url');
const {
  checkOAuthWireDiscoveryPreflight,
  isOAuthWireDiscoveryIgnoredByRootGitignore,
} =
  await import('../src/daemon/llm/provider/transport/responses-wire-discovery-preflight.ts');

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const preflight = await checkOAuthWireDiscoveryPreflight({
  repoRoot,
  experimentId,
  outputPath,
  async isGitIgnored(repoRelativePath) {
    try {
      await execFileAsync('git', ['check-ignore', '-q', repoRelativePath], {
        cwd: repoRoot,
      });
      return true;
    } catch {
      const gitignoreText = await readFile(
        join(repoRoot, '.gitignore'),
        'utf8',
      );
      return isOAuthWireDiscoveryIgnoredByRootGitignore({
        repoRelativePath,
        gitignoreText,
      });
    }
  },
});

if (!preflight.ok) {
  throw new Error(preflight.message);
}

if (isPreflight) {
  console.log('OAuth wire discovery preflight passed.');
  console.log(`Experiment: ${preflight.experimentId}`);
  console.log(`Request diff: ${preflight.requestDiffSummary}`);
  if (preflight.output.kind === 'runtime_artifact') {
    console.log(`Output path: ${preflight.output.outputPath}`);
  } else {
    console.log('Output artifact: none');
    console.log(`Blocked reason: ${preflight.output.reason}`);
  }
  for (const warning of preflight.warnings) {
    console.log(`- ${warning}`);
  }
  process.exit(0);
}

if (
  preflight.liveRunPolicy !== 'explicit_operator_approval_required' ||
  preflight.output.kind !== 'runtime_artifact'
) {
  throw new Error(
    `OAuth wire discovery experiment ${preflight.experimentId} is preflight-only and cannot run a live provider capture`,
  );
}

if (process.env.GEULBAT_OAUTH_WIRE_DISCOVERY !== '1') {
  throw new Error(
    'GEULBAT_OAUTH_WIRE_DISCOVERY=1 is required for live OAuth wire discovery',
  );
}

const { callModel } = await import('../src/daemon/llm/provider/client.ts');
const { createDaemonContext } = await import('../src/daemon/context.ts');
const {
  assertOAuthWireDiscoveryRecordIsSanitized,
  buildOAuthWireDiscoveryRecord,
} =
  await import('../src/daemon/llm/provider/transport/responses-wire-discovery.ts');

const absoluteOutputPath = preflight.output.outputPath;
const providerSessionId =
  process.env.GEULBAT_OAUTH_WIRE_DISCOVERY_SESSION_ID ?? randomUUID();
const prompt =
  process.env.GEULBAT_OAUTH_WIRE_DISCOVERY_PROMPT ??
  'Discovery baseline: reply with the single word pong.';

const daemonContext = createDaemonContext();
const requestSnapshots = [];
const eventSnapshots = [];

const chunks = [];
for await (const chunk of callModel({
  history: [{ kind: 'user', text: prompt }],
  systemPrompt:
    'You are running a transport-shape discovery baseline. Reply only with pong.',
  providerSessionId,
  providerWebSocketSessions: daemonContext.providerWebSocketSessions,
  providerAuthRuntime: daemonContext.providerAuthRuntime,
  providerRequestOptions: daemonContext.providerRequestOptions,
  oauthWireDiscoverySink: {
    recordRequest(snapshot) {
      requestSnapshots.push(snapshot);
    },
    recordEvent(snapshot) {
      eventSnapshots.push(snapshot);
    },
  },
})) {
  chunks.push(
    chunk.type === 'text_delta'
      ? { type: chunk.type, phase: chunk.phase ?? 'unknown' }
      : chunk.type === 'done'
        ? {
            type: chunk.type,
            hasFinalText: Boolean(chunk.finalText),
            structuredOutputCount: chunk.structuredOutputs?.length ?? 0,
            hasArtifactCandidate: chunk.artifactCandidate !== undefined,
          }
        : { type: chunk.type },
  );
}

if (requestSnapshots.length !== 1) {
  throw new Error(
    `expected exactly one request snapshot, got ${requestSnapshots.length}`,
  );
}

const record = buildOAuthWireDiscoveryRecord({
  capturedAt: new Date().toISOString(),
  request: requestSnapshots[0],
  events: eventSnapshots,
});

const output = {
  ...record,
  localRunSummary: {
    experiment: {
      id: preflight.experimentId,
      requestDiffSummary: preflight.requestDiffSummary,
    },
    chunkSummary: chunks,
    note: 'Sanitized local diagnostic evidence only. This does not prove provider-native structured-output support.',
  },
};

assertOAuthWireDiscoveryRecordIsSanitized(output);
await mkdir(dirname(absoluteOutputPath), { recursive: true });
await writeFile(
  absoluteOutputPath,
  `${JSON.stringify(output, null, 2)}\n`,
  'utf8',
);
console.log(
  `wrote sanitized OAuth wire discovery evidence: ${absoluteOutputPath}`,
);
