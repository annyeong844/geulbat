import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PTC_EXECUTE_CODE_CELL_ENABLED_ENV,
  PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV,
  PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV,
  PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV,
  resolvePtcExecuteCodeCellRuntimeConfigFromEnv,
} from './execute-code-runtime.js';
import { PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS } from './execute-code-cell-terminal-retention.js';

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv returns undefined when env is absent', () => {
  assert.equal(resolvePtcExecuteCodeCellRuntimeConfigFromEnv({}), undefined);
});
void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv accepts explicit cell settings', () => {
  assert.deepEqual(
    resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
      [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: ' true ',
      [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: ' 2500 ',
      [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: ' 600000 ',
    }),
    {
      enabled: true,
      initialYieldTimeMs: 2500,
      runningCellReapAfterMs: 600000,
      terminalResultMemoryRetentionMs:
        PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS,
    },
  );
  assert.deepEqual(
    resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
      [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
      [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '2500',
      [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
      [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: '45000',
    }),
    {
      enabled: true,
      initialYieldTimeMs: 2500,
      runningCellReapAfterMs: 600000,
      terminalResultMemoryRetentionMs: 45000,
    },
  );
  assert.deepEqual(
    resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
      [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'false',
    }),
    { enabled: false },
  );
});
void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid enabled values', () => {
  for (const value of ['', ' ', 'TRUE', '1', 'yes', '0']) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
          [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: value,
        }),
      new RegExp(`invalid ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}`),
    );
  }
});
void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid yield values', () => {
  for (const value of [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '9007199254740992',
  ]) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
          [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
          [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: value,
          [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
        }),
      new RegExp(`invalid ${PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV}`),
    );
  }
});
void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid running reap values', () => {
  for (const value of [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '9007199254740992',
  ]) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
          [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
          [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
          [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: value,
        }),
      new RegExp(`invalid ${PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV}`),
    );
  }
});
void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid terminal memory retention values', () => {
  for (const value of [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '9007199254740992',
  ]) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
          [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
          [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
          [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
          [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: value,
        }),
      new RegExp(
        `invalid ${PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV}`,
      ),
    );
  }
});
void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv requires enabled true for cell config', () => {
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
      }),
    new RegExp(
      `${PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV} is required when ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'false',
        [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
        [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
      }),
    new RegExp(
      `${PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV} is required when ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: '300000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'false',
        [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: '300000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
});
