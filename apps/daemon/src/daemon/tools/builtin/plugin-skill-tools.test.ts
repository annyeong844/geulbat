import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentRuntimeServices } from '../../daemon-runtime-contract.js';
import type {
  PluginSkillCatalogEntry,
  PluginSkillRuntime,
} from '../../extensions/plugin-skill-runtime.js';
import { isToolObjectParameters } from '../tool-registry-model.js';
import type { ToolExecutionContext } from '../types.js';
import { listFilesTool } from './list-files.js';
import { readFileTool } from './read-file.js';
import { skillSearchTool } from './skill-search.js';

const SKILL_ROOT = `geulbat-skill/installation-1/${'a'.repeat(64)}`;
const INSTRUCTIONS_REF = `${SKILL_ROOT}/SKILL.md`;
const SKILL: PluginSkillCatalogEntry = {
  skillRef: SKILL_ROOT,
  skillRootRef: SKILL_ROOT,
  instructionsRef: INSTRUCTIONS_REF,
  name: 'draft-helper',
  description: 'Review and improve a prose draft.',
  enabled: true,
  allowImplicitInvocation: false,
  runtimeStatus: 'available',
  sourcePlugin: {
    installationId: 'installation-1',
    name: 'writing-suite',
    displayName: 'Writing Suite',
    version: '1.2.3',
    contentDigest: `sha256:${'b'.repeat(64)}`,
  },
};
const DEPENDENT_SKILL_ROOT = `geulbat-skill/installation-1/${'d'.repeat(64)}`;
const DEPENDENT_SKILL: PluginSkillCatalogEntry = {
  ...SKILL,
  skillRef: DEPENDENT_SKILL_ROOT,
  skillRootRef: DEPENDENT_SKILL_ROOT,
  instructionsRef: `${DEPENDENT_SKILL_ROOT}/SKILL.md`,
  name: 'dependent-helper',
  allowImplicitInvocation: true,
  runtimeStatus: 'unavailable-tool-dependencies',
};

void test('skill_search structurally hides explicit-only Skills from implicit discovery', async () => {
  const implicitResult = await skillSearchTool.execute(
    { query: 'improve draft', invocation: 'implicit' },
    toolContext(createRuntime()),
  );

  assert.equal(skillSearchTool.exposure?.directOnly, true);
  assert.equal(skillSearchTool.exposure?.sdkVisible, false);
  assert.equal(skillSearchTool.sideEffectLevel, 'none');
  assert.equal(skillSearchTool.requiresApproval, false);
  assert.ok(isToolObjectParameters(skillSearchTool.parameters));
  assert.deepEqual(skillSearchTool.parameters.required, [
    'query',
    'invocation',
  ]);
  assert.equal(implicitResult.ok, true);
  const implicitPayload = JSON.parse(implicitResult.output) as {
    invocation: string;
    total: number;
    results: unknown[];
  };
  assert.equal(implicitPayload.invocation, 'implicit');
  assert.equal(implicitPayload.total, 0);
  assert.deepEqual(implicitPayload.results, []);

  const explicitResult = await skillSearchTool.execute(
    { query: 'improve draft', invocation: 'explicit' },
    toolContext(createRuntime()),
  );
  assert.equal(explicitResult.ok, true);
  const payload = JSON.parse(explicitResult.output) as {
    invocation: string;
    total: number;
    results: Array<{
      instructionsRef: string;
      allowImplicitInvocation: boolean;
      name: string;
    }>;
    note: string;
  };
  assert.equal(payload.invocation, 'explicit');
  assert.equal(payload.total, 1);
  assert.equal(payload.results[0]?.instructionsRef, INSTRUCTIONS_REF);
  assert.equal(payload.results[0]?.allowImplicitInvocation, false);
  assert.equal(
    payload.results.some((result) => result.name === DEPENDENT_SKILL.name),
    false,
  );
  assert.match(payload.note, /Read the complete instructionsRef/);
  assert.match(payload.note, /never run automatically/);
});

void test('read_file pages a verified plugin Skill file without exposing a host path', async () => {
  const result = await readFileTool.execute(
    { path: INSTRUCTIONS_REF, offset: 1, limit: 2 },
    toolContext(createRuntime()),
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    path: string;
    content: string;
    source: string;
    readOnly: boolean;
    skillRef: string;
    pluginName: string;
    packageRelativePath: string;
    fileContentDigest: string;
    versionToken: string;
  };
  assert.equal(payload.path, INSTRUCTIONS_REF);
  assert.equal(
    payload.content,
    'name: draft-helper\ndescription: Draft help.\n',
  );
  assert.equal(payload.source, 'plugin_skill');
  assert.equal(payload.readOnly, true);
  assert.equal(payload.skillRef, SKILL_ROOT);
  assert.equal(payload.pluginName, 'writing-suite');
  assert.equal(payload.packageRelativePath, 'skills/draft-helper/SKILL.md');
  assert.equal(payload.fileContentDigest, `sha256:${'c'.repeat(64)}`);
  assert.equal(payload.versionToken, `sha256:${'c'.repeat(64)}`);
  assert.equal(JSON.stringify(payload).includes('/managed/packages/'), false);
});

void test('list_files lists verified plugin Skill resources by logical ref', async () => {
  const result = await listFilesTool.execute(
    { path: SKILL_ROOT, recursive: false },
    toolContext(createRuntime()),
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    path: string;
    source: string;
    total: number;
    entries: Array<{ path: string; type: string }>;
  };
  assert.equal(payload.path, SKILL_ROOT);
  assert.equal(payload.source, 'plugin_skill');
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.entries, [
    { name: 'SKILL.md', path: INSTRUCTIONS_REF, type: 'file' },
    {
      name: 'references',
      path: `${SKILL_ROOT}/references`,
      type: 'directory',
    },
  ]);
});

void test('plugin Skill logical refs fail closed when the runtime is absent', async () => {
  const result = await readFileTool.execute(
    { path: INSTRUCTIONS_REF, limit: 1 },
    { callId: 'plugin-skill-runtime-absent' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
  assert.match(result.error ?? '', /runtime is unavailable/);
});

function createRuntime(): PluginSkillRuntime {
  return {
    async listPluginSkills() {
      return { skills: [SKILL, DEPENDENT_SKILL], diagnostics: [] };
    },
    async readEnabledSkillFile(logicalPath) {
      if (logicalPath !== INSTRUCTIONS_REF) {
        throw new Error('unknown logical file');
      }
      return {
        logicalPath,
        content:
          '---\nname: draft-helper\ndescription: Draft help.\n---\nInstructions\n',
        contentDigest: `sha256:${'c'.repeat(64)}`,
        skill: SKILL,
        packageRelativePath: 'skills/draft-helper/SKILL.md',
      };
    },
    async listEnabledSkillDirectory(logicalPath) {
      if (logicalPath !== SKILL_ROOT) {
        throw new Error('unknown logical directory');
      }
      return {
        logicalPath,
        entries: [
          { name: 'SKILL.md', path: INSTRUCTIONS_REF, type: 'file' },
          {
            name: 'references',
            path: `${SKILL_ROOT}/references`,
            type: 'directory',
          },
        ],
        skill: SKILL,
      };
    },
  };
}

function toolContext(runtime: PluginSkillRuntime): ToolExecutionContext {
  return {
    callId: 'plugin-skill-tool-call',
    agentSpawnRuntime: { pluginSkills: runtime } as AgentRuntimeServices,
  };
}
