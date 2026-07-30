import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

import {
  guardedLookupPublicAddress,
  type PublicHttpAddress,
} from './public-http-address-guard.js';
import {
  PUBLIC_HTTP_READ_PROTOCOL_VERSION,
  parsePublicHttpReadRequest,
  type PublicHttpReadRequest,
  type PublicHttpReadResponse,
} from './public-http-read-protocol.js';
import { parseHttpUrl } from '../daemon/utils/http-url-policy.js';
import { runDetached } from '../daemon/utils/run-detached.js';

interface PublicHttpReadHostDependencies {
  lookupPublicAddress?: (hostname: string) => Promise<PublicHttpAddress>;
}

class PublicHttpReadHostError extends Error {
  constructor(
    readonly reasonCode: Extract<
      PublicHttpReadResponse,
      { ok: false }
    >['reasonCode'],
    message: string,
  ) {
    super(message);
    this.name = 'PublicHttpReadHostError';
  }
}

export async function runPublicHttpReadHost(
  rawInput: string,
  dependencies: PublicHttpReadHostDependencies = {},
): Promise<PublicHttpReadResponse> {
  let value: unknown;
  try {
    value = JSON.parse(rawInput);
  } catch {
    return failure('invalid_request', 'public HTTP read input is not JSON');
  }
  const request = parsePublicHttpReadRequest(value);
  if (request === undefined) {
    return failure(
      'invalid_request',
      'public HTTP read input does not match the protocol',
    );
  }
  const parsed = parseHttpUrl(request.url, { label: 'public HTTP read URL' });
  if (!parsed.ok) {
    return failure('invalid_request', parsed.message);
  }

  let address: PublicHttpAddress;
  try {
    address = await (
      dependencies.lookupPublicAddress ??
      ((hostname) =>
        guardedLookupPublicAddress(hostname, {
          label: 'public HTTP read URL',
        }))
    )(parsed.url.hostname);
  } catch (error: unknown) {
    return failure(
      'dns_blocked',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    return await requestPublicHttpRead(parsed.url, address, request);
  } catch (error: unknown) {
    return error instanceof PublicHttpReadHostError
      ? failure(error.reasonCode, error.message)
      : failure(
          'network_error',
          error instanceof Error ? error.message : String(error),
        );
  }
}

function requestPublicHttpRead(
  url: URL,
  address: PublicHttpAddress,
  input: PublicHttpReadRequest,
): Promise<PublicHttpReadResponse> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };
    const request = client.request(
      url,
      {
        method: input.method,
        headers: input.headers,
        ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions.all) {
            callback(null, [address]);
            return;
          }
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        const common = {
          version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
          ok: true,
          status: response.statusCode ?? 0,
          location: readHeader(response.headers.location),
          contentType: readHeader(response.headers['content-type']),
          contentLength: readContentLength(response.headers['content-length']),
        } as const;
        if (input.responseBodyMode === 'discard') {
          response.on('error', (error) => finish(() => reject(error)));
          finish(() =>
            resolve({
              ...common,
              bodyBase64: '',
            }),
          );
          response.destroy();
          return;
        }
        if (
          input.maxResponseBytes !== undefined &&
          common.contentLength !== null &&
          common.contentLength > input.maxResponseBytes
        ) {
          finish(() =>
            resolve(
              failure(
                'response_too_large',
                `public HTTP read response exceeds ${input.maxResponseBytes} bytes`,
              ),
            ),
          );
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on('data', (chunk: Buffer) => {
          responseBytes += chunk.byteLength;
          if (
            input.maxResponseBytes !== undefined &&
            responseBytes > input.maxResponseBytes
          ) {
            finish(() =>
              resolve(
                failure(
                  'response_too_large',
                  `public HTTP read response exceeds ${input.maxResponseBytes} bytes`,
                ),
              ),
            );
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish(() =>
            resolve({
              ...common,
              bodyBase64: Buffer.concat(chunks).toString('base64'),
            }),
          ),
        );
        response.on('error', (error) => finish(() => reject(error)));
      },
    );
    request.on('timeout', () =>
      request.destroy(
        new PublicHttpReadHostError(
          'timeout',
          'public HTTP read request timed out',
        ),
      ),
    );
    request.on('error', (error) => finish(() => reject(error)));
    if (input.bodyBase64 === undefined) {
      request.end();
    } else {
      request.end(Buffer.from(input.bodyBase64, 'base64'));
    }
  });
}

function readHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function readContentLength(
  value: string | string[] | undefined,
): number | null {
  const header = readHeader(value);
  if (!header) {
    return null;
  }
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function failure(
  reasonCode: Extract<PublicHttpReadResponse, { ok: false }>['reasonCode'],
  message: string,
): PublicHttpReadResponse {
  return {
    version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
    ok: false,
    reasonCode,
    message,
  };
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string') {
      throw new TypeError('public HTTP read input is not UTF-8 text');
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  runDetached('network/public-http-read-host', async () => {
    try {
      const result = await runPublicHttpReadHost(await readStdin());
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(JSON.stringify(result), (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      process.exitCode = 0;
    } catch (error: unknown) {
      process.stderr.write(
        `public HTTP read host failed: ${
          error instanceof Error
            ? (error.stack ?? `${error.name}: ${error.message}`)
            : String(error)
        }\n`,
      );
      process.exitCode = 1;
    }
  });
}
