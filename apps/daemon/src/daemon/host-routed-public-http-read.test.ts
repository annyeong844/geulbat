import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createCommandSessionHost } from '../command-host/session-core.js';
import { PUBLIC_HTTP_READ_PROTOCOL_VERSION } from '../command-host/public-http-read-protocol.js';
import { createHostRoutedPublicHttpReadRuntime } from './host-routed-public-http-read.js';

async function createFixture(t: {
  after(fn: () => Promise<void> | void): void;
}) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-public-http-read-'));
  const hostCommands = createCommandSessionHost({
    inlineMaxBytes: 32,
    tailRingBytes: 32,
  });
  t.after(async () => {
    await hostCommands.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { hostCommands, stateRoot };
}

void test('host-routed public HTTP reads preserve complete lossless results', async (t) => {
  const fixture = await createFixture(t);
  const runtime = createHostRoutedPublicHttpReadRuntime({
    ...fixture,
    pageLimitBytes: 32,
    workerCommand: {
      execPath: process.execPath,
      args: [
        '-e',
        `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (request.maxResponseBytes !== 8192) throw new Error('missing response bound');
  const body = Buffer.from(request.method + ':' + request.url + ':' + 'x'.repeat(4096));
  process.stdout.write(JSON.stringify({
    version: ${PUBLIC_HTTP_READ_PROTOCOL_VERSION},
    ok: true,
    status: 200,
    location: null,
    contentType: 'text/plain',
    contentLength: body.byteLength,
    bodyBase64: body.toString('base64'),
  }));
});`,
      ],
    },
  });

  const result = await runtime.request({
    url: 'https://example.com/resource',
    method: 'GET',
    headers: { accept: 'text/plain' },
    responseBodyMode: 'full',
    maxResponseBytes: 8192,
  });

  assert.equal(result.ok, true);
  const body = Buffer.from(result.bodyBase64, 'base64').toString('utf8');
  assert.match(body, /^GET:https:\/\/example\.com\/resource:/u);
  assert.equal(body.endsWith('x'.repeat(4096)), true);
});

void test('host-routed public HTTP reads reject malformed child output', async (t) => {
  const fixture = await createFixture(t);
  const runtime = createHostRoutedPublicHttpReadRuntime({
    ...fixture,
    pageLimitBytes: 32,
    workerCommand: {
      execPath: process.execPath,
      args: ['-e', `process.stdin.resume(); process.stdout.write('{}');`],
    },
  });

  const result = await runtime.request({
    url: 'https://example.com/',
    method: 'HEAD',
    headers: {},
    responseBodyMode: 'discard',
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('expected malformed output to fail');
  }
  assert.equal(result.reasonCode, 'invalid_response');
});

void test('host-routed public HTTP reads do not launch after cancellation', async (t) => {
  const fixture = await createFixture(t);
  const controller = new AbortController();
  controller.abort();
  const runtime = createHostRoutedPublicHttpReadRuntime({
    ...fixture,
    pageLimitBytes: 32,
    workerCommand: {
      execPath: process.execPath,
      args: ['-e', `process.stdout.write('must not run');`],
    },
  });

  const result = await runtime.request({
    url: 'https://example.com/',
    method: 'GET',
    headers: {},
    responseBodyMode: 'full',
    signal: controller.signal,
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('expected cancellation');
  }
  assert.equal(result.reasonCode, 'aborted');
});

void test('replacement runtimes replay a read without mutating user state', async (t) => {
  const fixture = await createFixture(t);
  const userStatePath = join(fixture.stateRoot, 'user-state.txt');
  await writeFile(userStatePath, 'unchanged', 'utf8');
  const methods: string[] = [];
  const server = http.createServer((request, response) => {
    methods.push(request.method ?? '');
    void readFile(userStatePath).then(
      (body) => {
        response.writeHead(200, {
          'content-length': String(body.byteLength),
          'content-type': 'text/plain',
        });
        response.end(body);
      },
      (error: Error) => response.destroy(error),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const hostMainPath = fileURLToPath(
    new URL('../command-host/public-http-read-host-main.js', import.meta.url),
  );
  const workerCommand = {
    execPath: process.execPath,
    args: [
      '-e',
      `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const { pathToFileURL } = await import('node:url');
  const { runPublicHttpReadHost } = await import(pathToFileURL(process.argv[2]).href);
  const result = await runPublicHttpReadHost(input, {
    lookupPublicAddress: async () => ({ address: process.argv[3], family: 4 }),
  });
  process.stdout.write(JSON.stringify(result));
});`,
      'public-http-read-test-wrapper',
      hostMainPath,
      '127.0.0.1',
    ],
  } as const;
  const firstGeneration = createHostRoutedPublicHttpReadRuntime({
    ...fixture,
    pageLimitBytes: 32,
    workerCommand,
  });
  const replacementGeneration = createHostRoutedPublicHttpReadRuntime({
    ...fixture,
    pageLimitBytes: 32,
    workerCommand,
  });
  const request = {
    url: `http://public.example:${address.port}/state`,
    method: 'GET',
    headers: { accept: 'text/plain' },
    responseBodyMode: 'full',
  } as const;

  const first = await firstGeneration.request(request);
  const replayed = await replacementGeneration.request(request);

  assert.equal(first.ok, true);
  assert.equal(replayed.ok, true);
  assert.equal(
    first.ok ? Buffer.from(first.bodyBase64, 'base64').toString('utf8') : '',
    'unchanged',
  );
  assert.equal(
    replayed.ok
      ? Buffer.from(replayed.bodyBase64, 'base64').toString('utf8')
      : '',
    'unchanged',
  );
  assert.deepEqual(methods, ['GET', 'GET']);
  assert.equal(await readFile(userStatePath, 'utf8'), 'unchanged');
});
