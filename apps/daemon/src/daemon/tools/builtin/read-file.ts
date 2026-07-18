import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { readFilePage, type ReadFileResult } from '../../files/read-file.js';
import { splitTextLines } from '../../files/text-content.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import { resolvePluginSkillFileBrowsePath } from '../plugin-skill-browse.js';
import { resolveToolLibraryProjectionBrowsePath } from '../tool-library-projection-browse.js';
import { defineZodTool } from '../zod-tool.js';

const readFileArgsSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'path must not be empty.',
    })
    .describe(
      'A file path resolved from the current directory inside ComputerFileScope, a geulbat-sdk path/ref, or an opaque geulbat-skill ref returned by skill_search.',
    ),
  offset: z
    .number()
    .int('offset must be a non-negative integer.')
    .min(0, 'offset must be a non-negative integer.')
    .optional()
    .describe(
      'The line number to start reading from (0-based). Defaults to 0.',
    ),
  limit: z
    .number()
    .int('limit must be a positive integer.')
    .min(1, 'limit must be a positive integer.')
    .describe(
      'Required bounded page size in lines. Request only the smallest relevant slice and continue from nextOffset only when needed.',
    ),
});

export const readFileTool = defineZodTool({
  name: 'read_file',
  description:
    'Read a bounded line page from a file admitted by ComputerFileScope, a verified read-only geulbat-sdk file/ref, or an enabled bundled/installed plugin skill ref. Relative paths start from the current directory.',
  argsSchema: readFileArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  exposure: {
    directHot: true,
    sdkVisible: true,
    inCellCallable: true,
    directOnly: false,
    approvalRequired: false,
    effectClass: 'readOnly',
  },
  catalogSearchMetadata: {
    family: 'file',
    searchHints: ['cat file', 'open file', 'read file', 'show file'],
    tags: ['file', 'read', 'computer'],
    whenToUse:
      'Read a bounded line slice from a known filesystem, geulbat-sdk, or bundled/installed plugin skill ref after locating the relevant text.',
    notFor:
      'Listing directories, searching unknown paths, or unbounded whole-file reconnaissance.',
  },
  async executeParsed(args, ctx) {
    const inputPath = args.path;
    const offset = args.offset ?? 0;
    const limit = args.limit;

    try {
      const pluginSkillPath = await resolvePluginSkillFileBrowsePath({
        ctx,
        inputPath,
      });
      if (pluginSkillPath.kind === 'failure') {
        return toolError('not_found', pluginSkillPath.message);
      }
      let result: ReadFileResult;
      let provenance:
        | { root: 'computer' }
        | {
            source: 'tool_library_projection';
            readOnly: true;
            sdkVersion: string;
            sdkProjectionHash: `sha256:${string}`;
            policyId: string;
            computerFileShadowIgnored: boolean;
          }
        | {
            source: 'plugin_skill';
            readOnly: true;
            skillRef: string;
            skillName: string;
            instructionsRef: string;
            allowImplicitInvocation: boolean;
            pluginInstallationId: string;
            pluginName: string;
            pluginVersion: string;
            pluginContentDigest: string;
            packageRelativePath: string;
            fileContentDigest: `sha256:${string}`;
          };
      if (pluginSkillPath.kind === 'plugin_skill_file') {
        const pluginSkillFile = pluginSkillPath.file;
        const skillLines = splitTextLines(pluginSkillFile.content);
        const selectedSkillLines = skillLines.slice(offset, offset + limit);
        result = {
          path: pluginSkillFile.logicalPath,
          content:
            selectedSkillLines.join('\n') +
            (selectedSkillLines.length > 0 ? '\n' : ''),
          versionToken: pluginSkillFile.contentDigest,
          totalLines: skillLines.length,
          startLine: offset + 1,
          endLine: Math.min(offset + limit, skillLines.length),
        };
        const sourcePlugin = pluginSkillFile.skill.sourcePlugin;
        provenance = {
          source: 'plugin_skill',
          readOnly: true,
          skillRef: pluginSkillFile.skill.skillRef,
          skillName: pluginSkillFile.skill.name,
          instructionsRef: pluginSkillFile.skill.instructionsRef,
          allowImplicitInvocation:
            pluginSkillFile.skill.allowImplicitInvocation,
          pluginInstallationId: sourcePlugin.installationId,
          pluginName: sourcePlugin.name,
          pluginVersion: sourcePlugin.version,
          pluginContentDigest: sourcePlugin.contentDigest,
          packageRelativePath: pluginSkillFile.packageRelativePath,
          fileContentDigest: pluginSkillFile.contentDigest,
        };
      } else {
        const projectionPath = await resolveToolLibraryProjectionBrowsePath({
          ctx,
          inputPath,
        });
        if (projectionPath.kind === 'failure') {
          return toolError('not_found', projectionPath.message);
        }
        if (projectionPath.kind === 'projection_path') {
          const projectionFile = projectionPath.file;
          if (projectionFile === undefined) {
            return toolError(
              'not_found',
              'The requested tool library file is not projected',
            );
          }
          const projectionLines = splitTextLines(projectionFile.content);
          const selectedProjectionLines = projectionLines.slice(
            offset,
            offset + limit,
          );
          result = {
            path: projectionPath.logicalPath,
            content:
              selectedProjectionLines.join('\n') +
              (selectedProjectionLines.length > 0 ? '\n' : ''),
            versionToken: projectionPath.identity.sdkProjectionHash,
            totalLines: projectionLines.length,
            startLine: offset + 1,
            endLine: Math.min(offset + limit, projectionLines.length),
          };
          provenance = {
            source: 'tool_library_projection',
            readOnly: true,
            sdkVersion: projectionPath.identity.sdkVersion,
            sdkProjectionHash: projectionPath.identity.sdkProjectionHash,
            policyId: projectionPath.identity.policyId,
            computerFileShadowIgnored: projectionPath.computerFileShadowIgnored,
          };
        } else {
          const filePath = resolveComputerFileToolPath(ctx, inputPath);
          result = await readFilePage(filePath.absoluteRoot, filePath.path, {
            offset,
            limit,
          });
          provenance = { root: filePath.root };
        }
      }
      const totalLines = result.totalLines;

      const startIdx = offset;
      const endIdx = Math.min(startIdx + limit, totalLines);
      const selectedLines = splitTextLines(result.content);

      const hasMore = endIdx < totalLines;
      const startLine = startIdx + 1;
      const endLine = startIdx + selectedLines.length;

      const output = {
        path: result.path,
        content: result.content,
        versionToken: result.versionToken,
        totalLines,
        pageLimit: limit,
        startLine,
        endLine,
        hasMore,
        nextOffset: hasMore ? endIdx : null,
        ...provenance,
      };

      return { ok: true, output: JSON.stringify(output) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});
