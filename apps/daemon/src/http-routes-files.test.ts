import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import {
  isComputerDirectorySelectionResponse,
  isComputerFileScopeResponse,
} from '@geulbat/protocol/files';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getComputerFileRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('authenticated computer file scope route omits the raw host root', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/files/computer-scope`,
        { headers: authHeaders() },
      );
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      assert.equal(isComputerFileScopeResponse(body), true);
      if (daemonContext.computerFileScope) {
        assert.equal(
          JSON.stringify(body).includes(daemonContext.computerFileScope.root),
          false,
        );
      }
    },
    { daemonContext },
  );
});

void test('authenticated directory picker route returns a Computer-relative native selection', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const initialAbsolutePath = join(computerFileRoot, 'initial');
  const selectedAbsolutePath = join(computerFileRoot, 'selected');
  const observedInitialPaths: string[] = [];
  const observedSignals: AbortSignal[] = [];
  let selectionCount = 0;
  daemonContext.computerDirectoryPicker = {
    async select({ initialAbsolutePath: requestedInitialPath, signal }) {
      observedInitialPaths.push(requestedInitialPath);
      assert.ok(signal);
      observedSignals.push(signal);
      selectionCount += 1;
      return selectionCount === 1
        ? { kind: 'selected', absolutePath: selectedAbsolutePath }
        : { kind: 'cancelled' };
    },
    async close() {},
  };

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const selectedResponse = await fetch(
        `http://127.0.0.1:${port}/api/files/select-directory`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ root: 'computer', initialPath: 'initial' }),
        },
      );
      assert.equal(selectedResponse.status, 200);
      const selectedBody: unknown = await selectedResponse.json();
      assert.equal(isComputerDirectorySelectionResponse(selectedBody), true);
      assert.deepEqual(selectedBody, {
        status: 'selected',
        path: 'selected',
      });

      const cancelledResponse = await fetch(
        `http://127.0.0.1:${port}/api/files/select-directory`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ root: 'computer', initialPath: 'initial' }),
        },
      );
      assert.equal(cancelledResponse.status, 200);
      assert.deepEqual(await cancelledResponse.json(), {
        status: 'cancelled',
      });
    },
    { daemonContext },
  );

  assert.deepEqual(observedInitialPaths, [
    initialAbsolutePath,
    initialAbsolutePath,
  ]);
  assert.equal(
    observedSignals.every((signal) => !signal.aborted),
    true,
  );
});

void test('disconnecting a directory picker request aborts the owned native selection', async () => {
  const daemonContext = createRouteTestDaemonContext();
  let observedSignal: AbortSignal | undefined;
  let markSelectionStarted: (() => void) | undefined;
  let markSelectionAborted: (() => void) | undefined;
  const selectionStarted = new Promise<void>((resolve) => {
    markSelectionStarted = resolve;
  });
  const selectionAborted = new Promise<void>((resolve) => {
    markSelectionAborted = resolve;
  });
  daemonContext.computerDirectoryPicker = {
    select({ signal }) {
      assert.ok(signal);
      observedSignal = signal;
      markSelectionStarted?.();
      return new Promise((resolve) => {
        const cancelSelection = () => {
          markSelectionAborted?.();
          resolve({ kind: 'cancelled' });
        };
        if (signal.aborted) {
          cancelSelection();
          return;
        }
        signal.addEventListener('abort', cancelSelection, { once: true });
      });
    },
    async close() {},
  };

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const controller = new AbortController();
      const request = fetch(
        `http://127.0.0.1:${port}/api/files/select-directory`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ root: 'computer' }),
          signal: controller.signal,
        },
      );
      await selectionStarted;
      controller.abort();

      await assert.rejects(
        request,
        (error: unknown) =>
          error instanceof DOMException && error.name === 'AbortError',
      );
      await selectionAborted;
    },
    { daemonContext },
  );

  assert.equal(observedSignal?.aborted, true);
});

void test('authenticated file routes resolve root=computer without a project id', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  daemonContext.computerFileScope = {
    root: computerFileRoot,
    browseShortcuts: [],
  };
  const relativePath = `computer-root-${randomUUID()}.md`;
  const absolutePath = join(computerFileRoot, relativePath);
  await mkdir(computerFileRoot, { recursive: true });
  await fsWriteFile(absolutePath, '# computer root\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/files/read?root=computer&path=${encodeURIComponent(relativePath)}`,
          { headers: authHeaders() },
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as { content: string };
        assert.equal(body.content, '# computer root\n');

        const ambiguous = await fetch(
          `http://127.0.0.1:${port}/api/files/tree?root=computer&projectId=workspace`,
          { headers: authHeaders() },
        );
        assert.equal(ambiguous.status, 400);
      },
      { daemonContext },
    );
  } finally {
    await rm(absolutePath, { force: true });
  }
});

void test('authenticated files/read route rejects retired project scope', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/read?projectId=missing-project&path=note.md`,
      {
        headers: authHeaders(),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'projectId is not supported',
    });
  });
});

void test('authenticated files/read route requires the explicit computer root before path validation', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/files/read?path=`, {
      headers: authHeaders(),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'root must be computer',
    });
  });
});
