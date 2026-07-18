import { z } from 'zod';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import { buildToolSignatureRef } from '@geulbat/tool-library/projection-signature';
import type {
  RankedToolSearchResult,
  ToolSearchIndexCard,
} from '@geulbat/tool-library/search-ranking';
import {
  searchRankedToolCatalog,
  summarizeToolDescription,
} from '@geulbat/tool-library/search-ranking';
import { defineZodTool } from '../zod-tool.js';
import type { AnyTool, ToolCatalogSearchFamily } from '../types.js';

const toolSearchArgsSchema = z.strictObject({
  query: z
    .string()
    .min(1, 'query is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'query must not be empty.',
    })
    .describe(
      'Natural-language phrase for finding a currently registered Geulbat tool.',
    ),
});

type ToolSearchArgs = z.output<typeof toolSearchArgsSchema>;

export interface ToolSearchCatalogCard extends ToolSearchIndexCard {
  publicName: string;
  family: ToolCatalogSearchFamily;
  summary: string;
  searchHints: readonly string[];
  tags: readonly string[];
  sideEffectLevel: SideEffectLevel;
  approvalClass: 'approval_free' | 'approval_required';
  mayMutateComputerFiles: boolean;
  signatureRef: string;
  whenToUse: string;
  notFor: string;
}

type ToolSearchResult = RankedToolSearchResult<ToolSearchCatalogCard>;

interface ToolSearchOutput {
  ok: true;
  query: string;
  total: number;
  results: ToolSearchResult[];
  note: string;
}

export function createToolSearchTool(deps: {
  getCatalog: () => readonly ToolSearchCatalogCard[];
}) {
  return defineZodTool({
    name: 'tool_search',
    description:
      'Search the current registered Geulbat tool catalog with BM25 ranking. Returns catalog cards only; it does not execute tools or grant permissions.',
    argsSchema: toolSearchArgsSchema,
    sideEffectLevel: 'none',
    mayMutateComputerFiles: false,
    requiresApproval: false,
    catalogSearchMetadata: {
      family: 'catalog',
      searchHints: ['find tool', 'search tools', 'tool catalog'],
      tags: ['tool', 'catalog', 'discovery'],
      whenToUse:
        'Find the current registered tool that matches an intended action.',
      notFor: 'Executing the discovered tool or granting authority.',
    },
    async executeParsed(args: ToolSearchArgs, ctx) {
      const allowedRegistryNames =
        ctx.allowedRegistryNames === undefined
          ? undefined
          : new Set(ctx.allowedRegistryNames);
      const catalog =
        allowedRegistryNames === undefined
          ? deps.getCatalog()
          : deps
              .getCatalog()
              .filter((card) => allowedRegistryNames.has(card.publicName));
      const results = searchToolCatalog(args.query, catalog);
      const output: ToolSearchOutput = {
        ok: true,
        query: args.query.trim(),
        total: results.length,
        results,
        note: 'tool_search returns BM25-ranked live registered catalog cards only. Search hints are not callable aliases.',
      };
      return { ok: true, output: JSON.stringify(output) };
    },
  });
}

export function buildToolSearchCatalog(
  tools: readonly AnyTool[],
): readonly ToolSearchCatalogCard[] {
  return Object.freeze(
    tools
      .map((tool) => buildToolSearchCatalogCard(tool))
      .sort((a, b) => a.publicName.localeCompare(b.publicName)),
  );
}

export function searchToolCatalog(
  query: string,
  catalog: readonly ToolSearchCatalogCard[],
): ToolSearchResult[] {
  return searchRankedToolCatalog(query, catalog);
}

function buildToolSearchCatalogCard(tool: AnyTool): ToolSearchCatalogCard {
  const metadata = tool.catalogSearchMetadata;
  const summary =
    metadata?.summary ?? summarizeToolDescription(tool.description);
  return {
    publicName: tool.name,
    family: metadata?.family ?? 'catalog',
    summary,
    searchHints: metadata?.searchHints ?? [],
    tags: metadata?.tags ?? [tool.sideEffectLevel],
    sideEffectLevel: tool.sideEffectLevel,
    approvalClass: tool.requiresApproval
      ? 'approval_required'
      : 'approval_free',
    mayMutateComputerFiles: tool.mayMutateComputerFiles,
    signatureRef: buildToolSignatureRef(tool.name),
    whenToUse: metadata?.whenToUse ?? summary,
    notFor:
      metadata?.notFor ??
      'Unavailable behavior must be handled by another registered tool.',
  };
}
