import assert from 'node:assert/strict';
import test from 'node:test';
import { definedPtcProps } from './record-shape.js';

void test('definedPtcProps omits undefined fields without dropping meaningful values', () => {
  assert.deepEqual(
    definedPtcProps({
      absent: undefined,
      count: 0,
      enabled: false,
      label: '',
      nullable: null,
    }),
    {
      count: 0,
      enabled: false,
      label: '',
      nullable: null,
    },
  );
});
