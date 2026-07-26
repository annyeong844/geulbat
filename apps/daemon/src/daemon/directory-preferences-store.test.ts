import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isDirectoryPreferencesResponse } from '@geulbat/protocol/files';

import {
  applyDirectoryPreference,
  readDirectoryPreferences,
} from './directory-preferences-store.js';

void test('directory preferences preserve complete DTO-valid MRU history', async () => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'directory-preferences-store-'),
  );
  const selectedPaths = Array.from(
    { length: 11 },
    (_, index) => `/computer/work-${index + 1}`,
  );

  try {
    for (const path of selectedPaths) {
      await applyDirectoryPreference({
        homeStateRoot,
        action: { kind: 'select', path },
        now: () => new Date('2026-07-26T00:00:00.000Z'),
      });
    }
    await applyDirectoryPreference({
      homeStateRoot,
      action: { kind: 'select', path: selectedPaths[3]! },
      now: () => new Date('2026-07-26T00:00:01.000Z'),
    });

    const preferences = await readDirectoryPreferences(homeStateRoot);
    assert.equal(isDirectoryPreferencesResponse(preferences), true);
    assert.equal(preferences.workingDirectory, selectedPaths[3]);
    assert.deepEqual(
      preferences.recents.map((entry) => entry.path),
      [
        selectedPaths[3],
        ...selectedPaths.filter((path) => path !== selectedPaths[3]).reverse(),
      ],
    );
  } finally {
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});
