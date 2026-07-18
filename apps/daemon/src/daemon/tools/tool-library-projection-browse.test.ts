import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { testThreadId } from '../../test-support/thread-id.js';
import { createDaemonContext } from '../context.js';
import { listFilesTool } from './builtin/list-files.js';
import { readFileTool } from './builtin/read-file.js';

void test('file tools browse the Home-owned geulbat-sdk projection independently of the current file directory', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-browse-'),
  );
  const browsingRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-browse-files-'),
  );
  const shadowFile = join(
    browsingRoot,
    'geulbat-sdk',
    'signatures',
    'search-memory-index.js',
  );
  await mkdir(join(shadowFile, '..'), { recursive: true });
  await writeFile(shadowFile, 'computer file shadow must not win\n', 'utf8');

  const daemonContext = createDaemonContext();
  const threadId = testThreadId(9301);
  try {
    const projection =
      await daemonContext.toolLibraryProjection.resolveProjection({
        stateRoot,
        threadId,
      });
    assert.equal(projection.ok, true);
    if (!projection.ok) {
      assert.fail('expected tool library projection');
    }
    const projectedTool = projection.projection.tools.find(
      (tool) => tool.publicName === 'search_memory_index',
    );
    assert.ok(projectedTool);
    const ctx = {
      callId: 'browse-sdk',
      computerFileRoot: browsingRoot,
      stateRoot,
      threadId,
      agentSpawnRuntime: daemonContext,
      toolLibraryProjectionIdentity: {
        sdkVersion: projection.pin.sdkVersion,
        sdkProjectionHash: projection.pin.sdkProjectionHash,
        policyId: projection.pin.policyId,
      },
    };

    const listing = await listFilesTool.execute(
      { path: 'geulbat-sdk/signatures' },
      ctx,
    );
    assert.equal(listing.ok, true);
    const listingPayload = JSON.parse(listing.output) as {
      path: string;
      sdkVersion: string;
      sdkProjectionHash: string;
      readOnly: boolean;
      computerFileShadowIgnored: boolean;
      entries: Array<{ path: string; type: string }>;
    };
    assert.equal(listingPayload.path, 'geulbat-sdk/signatures');
    assert.equal(listingPayload.sdkVersion, projection.pin.sdkVersion);
    assert.equal(
      listingPayload.sdkProjectionHash,
      projection.pin.sdkProjectionHash,
    );
    assert.equal(listingPayload.readOnly, true);
    assert.equal(listingPayload.computerFileShadowIgnored, true);
    assert.ok(
      listingPayload.entries.some(
        (entry) =>
          entry.path === `geulbat-sdk/${projectedTool.signatureModule}` &&
          entry.type === 'file',
      ),
    );

    const signature = await readFileTool.execute(
      { path: projectedTool.signatureRef, limit: 1 },
      ctx,
    );
    assert.equal(signature.ok, true);
    const signaturePayload = JSON.parse(signature.output) as {
      path: string;
      content: string;
      sdkVersion: string;
      sdkProjectionHash: string;
      readOnly: boolean;
    };
    assert.equal(signaturePayload.path, projectedTool.signatureRef);
    assert.equal(signaturePayload.sdkVersion, projection.pin.sdkVersion);
    assert.equal(
      signaturePayload.sdkProjectionHash,
      projection.pin.sdkProjectionHash,
    );
    assert.equal(signaturePayload.readOnly, true);
    assert.match(
      signaturePayload.content,
      new RegExp(projectedTool.wrapperImportSpecifier.replaceAll('/', '\\/')),
    );
    assert.doesNotMatch(signaturePayload.content, /computer file shadow/u);
    assert.doesNotMatch(
      signature.output,
      /\.geulbat|tool-library\/projections/u,
    );

    const traversal = await readFileTool.execute(
      { path: 'geulbat-sdk/../projection-pin.json', limit: 1 },
      ctx,
    );
    assert.equal(traversal.ok, false);
    assert.equal(traversal.errorCode, 'not_found');
  } finally {
    await Promise.all([
      rm(stateRoot, { recursive: true, force: true }),
      rm(browsingRoot, { recursive: true, force: true }),
    ]);
  }
});
