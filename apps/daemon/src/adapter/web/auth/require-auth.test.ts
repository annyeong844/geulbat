import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from './require-auth.js';
import {
  resetShellAuthFailureRateLimitForTests,
  SHELL_AUTH_FAILURE_LIMIT,
} from './auth-failure-rate-limit.js';

function withTokenEnv(token: string, fn: () => void): void {
  const previous = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = token;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env['GEULBAT_DEV_TOKEN'];
    } else {
      process.env['GEULBAT_DEV_TOKEN'] = previous;
    }
  }
}

function createResponseCapture() {
  const capture = {
    statusCode: 200,
    body: null as unknown,
    headers: Object.create(null) as Record<string, string>,
  };
  const response = {
    status(code: number) {
      capture.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      capture.headers[name.toLowerCase()] = value;
      return this;
    },
    json(payload: unknown) {
      capture.body = payload;
      return this;
    },
  } as Partial<Response>;
  return { capture, response };
}

void test('requireAuth returns 401 when the dev token header is missing', () => {
  resetShellAuthFailureRateLimitForTests();
  withTokenEnv('test-token-123456', () => {
    const { capture, response } = createResponseCapture();
    let nextCalled = false;
    const request = {
      headers: {},
      ip: '127.0.0.11',
    } as Partial<Request>;

    requireAuth(
      request as Request,
      response as Response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );

    assert.equal(nextCalled, false);
    assert.equal(capture.statusCode, 401);
    assert.deepEqual(capture.body, {
      code: 'unauthorized',
      message: 'missing or invalid X-Geulbat-Dev-Token',
    });
  });
});

void test('requireAuth calls next when the dev token header matches', () => {
  resetShellAuthFailureRateLimitForTests();
  withTokenEnv('test-token-123456', () => {
    const { capture, response } = createResponseCapture();
    let nextCalled = false;
    const request = {
      headers: { 'x-geulbat-dev-token': 'test-token-123456' },
      ip: '127.0.0.12',
    } as Partial<Request>;

    requireAuth(
      request as Request,
      response as Response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );

    assert.equal(nextCalled, true);
    assert.equal(capture.statusCode, 200);
    assert.equal(capture.body, null);
  });
});

void test('requireAuth calls next when the dev auth cookie matches', () => {
  resetShellAuthFailureRateLimitForTests();
  withTokenEnv('test-token-123456', () => {
    const { capture, response } = createResponseCapture();
    let nextCalled = false;
    const request = {
      headers: { cookie: 'geulbat_dev_auth=test-token-123456' },
      ip: '127.0.0.13',
    } as Partial<Request>;

    requireAuth(
      request as Request,
      response as Response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );

    assert.equal(nextCalled, true);
    assert.equal(capture.statusCode, 200);
    assert.equal(capture.body, null);
  });
});

void test('requireAuth rate limits repeated authentication failures from the same client', () => {
  resetShellAuthFailureRateLimitForTests();
  withTokenEnv('test-token-123456', () => {
    for (let index = 0; index < SHELL_AUTH_FAILURE_LIMIT; index += 1) {
      const { capture, response } = createResponseCapture();
      let nextCalled = false;
      const request = {
        headers: {},
        ip: '127.0.0.21',
      } as Partial<Request>;

      requireAuth(
        request as Request,
        response as Response,
        (() => {
          nextCalled = true;
        }) as NextFunction,
      );

      assert.equal(nextCalled, false);
      assert.equal(capture.statusCode, 401);
    }

    const { capture, response } = createResponseCapture();
    let nextCalled = false;
    const request = {
      headers: {},
      ip: '127.0.0.21',
    } as Partial<Request>;

    requireAuth(
      request as Request,
      response as Response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );

    assert.equal(nextCalled, false);
    assert.equal(capture.statusCode, 429);
    assert.equal(capture.headers['retry-after'], '60');
    assert.deepEqual(capture.body, {
      code: 'rate_limited',
      message: 'too many authentication failures; retry later',
    });
  });
});
