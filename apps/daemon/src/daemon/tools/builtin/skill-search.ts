import { searchRankedToolCatalog } from '@geulbat/tool-library/search-ranking';
import { z } from 'zod';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const skillSearchArgsSchema = z.strictObject({
  query: z
    .string()
    .min(1, 'query is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'query must not be empty.',
    })
    .describe('Plain-language capability or workflow to find.'),
  invocation: z
    .enum(['implicit', 'explicit'])
    .describe(
      'Use implicit for agent-initiated discovery. Use explicit only when the user explicitly requested the Skill.',
    ),
});

export const skillSearchTool = defineZodTool({
  name: 'skill_search',
  description:
    'Search enabled bundled and installed plugin Skill metadata with BM25 ranking. Returns opaque read-only instruction refs; it does not execute Skill scripts, tools, MCP servers, or apps.',
  argsSchema: skillSearchArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  exposure: {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
    effectClass: 'readOnly',
  },
  catalogSearchMetadata: {
    family: 'catalog',
    searchHints: ['find skill', 'search skills', 'plugin workflow'],
    tags: ['skill', 'plugin', 'catalog', 'discovery'],
    whenToUse:
      'Find an enabled bundled or installed plugin Skill before reading its complete instructions and only the needed resources.',
    notFor:
      'Executing scripts, activating unavailable tool dependencies, or granting plugin authority.',
  },
  async executeParsed(args, ctx) {
    const runtime = ctx.agentSpawnRuntime?.pluginSkills;
    if (runtime === undefined) {
      return toolError('execution_failed', 'Plugin skill runtime is required.');
    }

    try {
      const inventory = await runtime.listPluginSkills();
      const query = args.query.trim();
      const cards = inventory.skills
        .filter(
          (skill) =>
            skill.runtimeStatus === 'available' &&
            (args.invocation === 'explicit' || skill.allowImplicitInvocation),
        )
        .map((skill) => ({
          publicName: `${skill.sourcePlugin.name}:${skill.name}`,
          family: 'skill',
          summary: skill.description,
          searchHints: [
            skill.name,
            skill.sourcePlugin.name,
            skill.sourcePlugin.displayName,
          ],
          tags: ['skill', skill.name, skill.sourcePlugin.name],
          whenToUse: skill.description,
          skill,
        }));
      const visibleResults = searchRankedToolCatalog(query, cards).map(
        ({ rank, score, skill }) => ({ rank, score, ...skill }),
      );
      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          query,
          invocation: args.invocation,
          total: visibleResults.length,
          results: visibleResults,
          diagnostics: inventory.diagnostics,
          note: 'Results contain metadata and opaque read-only refs only. Read the complete instructionsRef with read_file before following a Skill; read only needed resources beneath skillRootRef. Implicit discovery excludes Skills whose allowImplicitInvocation is false. Skill scripts never run automatically or grant tool authority.',
        }),
      };
    } catch {
      return toolError(
        'execution_failed',
        'The plugin skill catalog could not be verified.',
      );
    }
  },
});
