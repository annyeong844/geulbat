import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentLoopToolDefinitionPort } from '../../agent/loop-tool-definitions.js';
import { createDaemonContext } from '../../context.js';
import { executeTool } from '../executor.js';
import type { CallbackToolDispatcher } from '../types.js';
import { executeCodeTool } from './execute-code.js';
import { listFilesTool } from './list-files.js';
import { readFileTool } from './read-file.js';

const dockerTest =
  process.env.GEULBAT_RUN_DOCKER_E2E === '1' ? test : test.skip;

void dockerTest(
  'removed tool discovery and mounted SDK import share one pinned projection',
  async () => {
    const computerFileRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-sdk-mounted-tree-computer-files-'),
    );
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-sdk-mounted-tree-state-'),
    );
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-sdk-mounted-tree-runtime-'),
    );
    const threadId = testThreadId(962);
    const daemonContext = createDaemonContext({
      ptcExecuteCodeRuntimeOptions: {
        callbackTransportPolicy: {
          maxFrameBytes: 8192,
          maxOpenConnections: 4,
          maxCallbacks: 20,
          callbackTimeoutMs: 30_000,
          maxResponseBytes: 8192,
        },
        packageInstall: { enabled: false },
        realpathStateRoot: async () => stateRoot,
        runtimeRootForState: () => runtimeRoot,
      },
    });
    const callbackToolDispatcher: CallbackToolDispatcher = {
      async dispatch({ toolName, args, runtimeToolCallId, signal }) {
        assert.equal(toolName, 'search_memory_index');
        return await executeTool(
          toolName,
          args,
          {
            callId: runtimeToolCallId,
            computerFileRoot,
            threadId,
            stateRoot,
            workingDirectory: '',
            signal,
            runSignal: signal,
            memoryIndex: daemonContext.memoryIndex,
          },
          { toolRegistry: daemonContext.toolRegistry },
        );
      },
    };

    try {
      await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
      await writeFile(
        join(computerFileRoot, 'docs', 'mounted-sdk.txt'),
        'mounted SDK parity evidence\n',
        'utf8',
      );
      await daemonContext.memoryIndex.refreshMemoryIndex({
        stateRoot,
        sourceRoot: computerFileRoot,
      });
      const projection =
        await daemonContext.toolLibraryProjection.resolveProjection({
          stateRoot,
          threadId,
        });
      assert.equal(projection.ok, true);
      if (!projection.ok) {
        assert.fail('expected pinned SDK projection');
      }
      const toolContext = {
        computerFileRoot,
        threadId,
        stateRoot,
        workingDirectory: '',
        agentSpawnRuntime: daemonContext,
        callbackToolDispatcher,
        toolLibraryProjectionIdentity: {
          sdkVersion: projection.pin.sdkVersion,
          sdkProjectionHash: projection.pin.sdkProjectionHash,
          policyId: projection.pin.policyId,
        },
      };
      const directNames = createAgentLoopToolDefinitionPort(
        daemonContext.toolRegistry,
      )
        .buildToolDefinitions({})
        .map((definition) => definition.name);
      assert.equal(directNames.includes('search_memory_index'), false);

      const search = await executeTool(
        'tool_search',
        { query: 'search the memory index' },
        { ...toolContext, callId: 'sdk-discovery-search' },
        { toolRegistry: daemonContext.toolRegistry },
      );
      assert.equal(search.ok, true);
      const searchPayload = JSON.parse(search.output) as {
        results: Array<{ publicName: string; signatureRef: string }>;
      };
      const discovered = searchPayload.results.find(
        (result) => result.publicName === 'search_memory_index',
      );
      assert.ok(discovered);

      const listing = await listFilesTool.execute(
        { path: 'geulbat-sdk/signatures' },
        { ...toolContext, callId: 'sdk-discovery-list' },
      );
      assert.equal(listing.ok, true);
      const signature = await readFileTool.execute(
        { path: discovered.signatureRef, limit: 1 },
        { ...toolContext, callId: 'sdk-discovery-read' },
      );
      assert.equal(signature.ok, true);
      const browseIdentity = JSON.parse(signature.output) as {
        content: string;
        sdkVersion: string;
        sdkProjectionHash: string;
      };
      const wrapperSpecifier = /"wrapperImportSpecifier":"([^"]+)"/u.exec(
        browseIdentity.content,
      )?.[1];
      assert.equal(wrapperSpecifier, 'geulbat-sdk/tools/search-memory-index');
      const discoveryBytes =
        Buffer.byteLength(listing.output, 'utf8') +
        Buffer.byteLength(signature.output, 'utf8');
      const fullTreeBytes = projection.projection.files.reduce(
        (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
        0,
      );
      assert.ok(discoveryBytes < fullTreeBytes);

      const exec = await executeCodeTool.execute(
        {
          code: [
            `const sdk = require(${JSON.stringify(wrapperSpecifier)});`,
            `if (sdk.sdkVersion !== ${JSON.stringify(browseIdentity.sdkVersion)}) throw new Error('SDK version parity failed');`,
            `if (sdk.sdkProjectionHash !== ${JSON.stringify(browseIdentity.sdkProjectionHash)}) throw new Error('SDK projection parity failed');`,
            "let sdkWriteBlocked = false; try { require('node:fs').writeFileSync('/geulbat/sdk/tools/search-memory-index.js', 'tampered'); } catch { sdkWriteBlocked = true; }",
            "if (!sdkWriteBlocked) throw new Error('mounted SDK was writable');",
            "const result = await sdk.searchMemoryIndex({ query: 'mounted SDK parity evidence', pathPrefix: 'docs' });",
            "if (result.kind !== 'inline') throw new Error('memory result was offloaded');",
            'const payload = JSON.parse(result.value.output);',
            'console.log(JSON.stringify({ sdkVersion: sdk.sdkVersion, sdkProjectionHash: sdk.sdkProjectionHash, path: payload.results[0].path }));',
          ].join('\n'),
          timeoutMs: 10_000,
        },
        { ...toolContext, callId: 'sdk-mounted-exec' },
      );
      if (!exec.ok) {
        assert.fail(exec.error);
      }
      const execPayload = JSON.parse(exec.output) as { stdout: string };
      assert.match(execPayload.stdout, /docs\/mounted-sdk\.txt/u);
      assert.match(execPayload.stdout, /geulbat-tool-library-sdk-v1/u);
      assert.match(execPayload.stdout, /sha256:[0-9a-f]{64}/u);
      assert.ok(!execPayload.stdout.includes(projection.projection.rootPath));
      assert.doesNotMatch(
        execPayload.stdout,
        /(?:^|[/\\])\.geulbat(?:[/\\]|$)|tool-library[/\\]projections/u,
      );
    } finally {
      await daemonContext.ptcExecuteCode.closeAll();
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(computerFileRoot, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  },
);
