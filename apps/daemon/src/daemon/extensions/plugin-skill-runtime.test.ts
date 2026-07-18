import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PluginSkillDocumentError,
  parsePluginSkillDocument,
} from './plugin-skill-runtime.js';

void test('plugin skill preserves cross-client discovery metadata without granting optional authoring fields authority', () => {
  const authoredDescription = 'Cross-client discovery metadata. '
    .repeat(40)
    .trim();
  assert.ok(authoredDescription.length > 1024);
  const parsed = parsePluginSkillDocument({
    entryPath: 'skills/zotero/SKILL.md',
    content: Buffer.from(
      `---\nname: Zotero\ndescription: ${JSON.stringify(authoredDescription)}\nmetadata:\n  priority: 2\n  docs:\n    - https://example.invalid/docs\n  tags: [research, citations]\nallowed-tools:\n  - Bash(curl *)\n  - Read\n---\n# Zotero\n`,
      'utf8',
    ),
    resourcePaths: [],
  });

  assert.equal(parsed.name, 'Zotero');
  assert.equal(parsed.description, authoredDescription);
  assert.equal(parsed.runtimeStatus, 'available');
});

void test('plugin skill rejects names beyond the published compatibility boundary', () => {
  assert.throws(
    () =>
      parsePluginSkillDocument({
        entryPath: 'skills/example/SKILL.md',
        content: Buffer.from(
          `---\nname: ${'a'.repeat(65)}\ndescription: Example\n---\n# Example\n`,
          'utf8',
        ),
        resourcePaths: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof PluginSkillDocumentError);
      assert.match(error.message, /name is too long/u);
      return true;
    },
  );
});

void test('plugin skill compatibility limit does not normalize graphemes', () => {
  const compatibilityAtLimit = 'e\u0301'.repeat(250);

  assert.doesNotThrow(() =>
    parsePluginSkillDocument({
      entryPath: 'skills/example/SKILL.md',
      content: Buffer.from(
        `---\nname: example\ndescription: Example\ncompatibility: ${compatibilityAtLimit}\n---\n# Example\n`,
        'utf8',
      ),
      resourcePaths: [],
    }),
  );
  assert.throws(
    () =>
      parsePluginSkillDocument({
        entryPath: 'skills/example/SKILL.md',
        content: Buffer.from(
          `---\nname: example\ndescription: Example\ncompatibility: ${compatibilityAtLimit}a\n---\n# Example\n`,
          'utf8',
        ),
        resourcePaths: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof PluginSkillDocumentError);
      assert.match(error.message, /compatibility is invalid/u);
      return true;
    },
  );
});

void test('plugin skill YAML parser errors become document errors', () => {
  assert.throws(
    () =>
      parsePluginSkillDocument({
        entryPath: 'skills/example/SKILL.md',
        content: Buffer.from(
          '---\nname: example\nname: duplicate\ndescription: Example\n---\n# Example\n',
          'utf8',
        ),
        resourcePaths: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof PluginSkillDocumentError);
      assert.match(error.message, /YAML is invalid/u);
      return true;
    },
  );
});
