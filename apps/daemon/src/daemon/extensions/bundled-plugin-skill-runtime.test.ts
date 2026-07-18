import assert from 'node:assert/strict';
import test from 'node:test';

import { createBundledPluginSkillRuntime } from './bundled-plugin-skill-runtime.js';
import type { PluginSkillRuntime } from './plugin-skill-runtime.js';

const EMPTY_INSTALLED_RUNTIME: PluginSkillRuntime = {
  async listPluginSkills() {
    return { skills: [], diagnostics: [] };
  },
  async readEnabledSkillFile() {
    throw new Error('installed skill not found');
  },
  async listEnabledSkillDirectory() {
    throw new Error('installed skill directory not found');
  },
};

void test('bundled creator skills use the verified plugin skill read surface', async () => {
  const runtime = createBundledPluginSkillRuntime({
    installed: EMPTY_INSTALLED_RUNTIME,
  });

  const inventory = await runtime.listPluginSkills();
  assert.deepEqual(
    inventory.skills.map((skill) => skill.name),
    ['plugin-creator', 'skill-creator'],
  );
  assert.equal(inventory.diagnostics.length, 0);
  assert.ok(inventory.skills.every((skill) => skill.enabled));
  assert.ok(
    inventory.skills.every(
      (skill) => skill.sourcePlugin.name === 'geulbat-creators',
    ),
  );

  const skill = inventory.skills.find(
    (candidate) => candidate.name === 'skill-creator',
  );
  assert.ok(skill);
  const instructions = await runtime.readEnabledSkillFile(
    skill.instructionsRef,
  );
  assert.equal(instructions.skill.skillRef, skill.skillRef);
  assert.equal(
    instructions.packageRelativePath,
    'skills/skill-creator/SKILL.md',
  );
  assert.match(instructions.content, /name: skill-creator/u);

  const directory = await runtime.listEnabledSkillDirectory(
    skill.skillRootRef,
    false,
  );
  assert.deepEqual(directory.entries, [
    {
      name: 'SKILL.md',
      path: `${skill.skillRootRef}/SKILL.md`,
      type: 'file',
    },
  ]);
});
