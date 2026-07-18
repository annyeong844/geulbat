import { isPluginSkillLogicalPath } from '@geulbat/protocol/plugins';

import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type { ToolExecutionContext } from './types.js';

type PluginSkillRuntime = AgentRuntimeServices['pluginSkills'];
type PluginSkillFile = Awaited<
  ReturnType<PluginSkillRuntime['readEnabledSkillFile']>
>;
type PluginSkillDirectory = Awaited<
  ReturnType<PluginSkillRuntime['listEnabledSkillDirectory']>
>;

type PluginSkillFileBrowseResult =
  | { kind: 'computer_path' }
  | { kind: 'failure'; message: string }
  | { kind: 'plugin_skill_file'; file: PluginSkillFile };

type PluginSkillDirectoryBrowseResult =
  | { kind: 'computer_path' }
  | { kind: 'failure'; message: string }
  | { kind: 'plugin_skill_directory'; directory: PluginSkillDirectory };

export async function resolvePluginSkillFileBrowsePath(args: {
  ctx: ToolExecutionContext;
  inputPath: string;
}): Promise<PluginSkillFileBrowseResult> {
  if (!isPluginSkillLogicalPath(args.inputPath)) {
    return { kind: 'computer_path' };
  }

  const runtime = args.ctx.agentSpawnRuntime?.pluginSkills;
  if (runtime === undefined) {
    return {
      kind: 'failure',
      message: 'The plugin skill runtime is unavailable',
    };
  }

  try {
    return {
      kind: 'plugin_skill_file',
      file: await runtime.readEnabledSkillFile(args.inputPath),
    };
  } catch {
    return {
      kind: 'failure',
      message: 'The requested plugin skill file could not be verified',
    };
  }
}

export async function resolvePluginSkillDirectoryBrowsePath(args: {
  ctx: ToolExecutionContext;
  inputPath: string;
  recursive: boolean;
}): Promise<PluginSkillDirectoryBrowseResult> {
  if (!isPluginSkillLogicalPath(args.inputPath)) {
    return { kind: 'computer_path' };
  }

  const runtime = args.ctx.agentSpawnRuntime?.pluginSkills;
  if (runtime === undefined) {
    return {
      kind: 'failure',
      message: 'The plugin skill runtime is unavailable',
    };
  }

  try {
    return {
      kind: 'plugin_skill_directory',
      directory: await runtime.listEnabledSkillDirectory(
        args.inputPath,
        args.recursive,
      ),
    };
  } catch {
    return {
      kind: 'failure',
      message: 'The requested plugin skill directory could not be verified',
    };
  }
}
