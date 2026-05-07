interface BuildPromptContextArgs {
  projectId: string;
  threadId: string;
  currentFile: string | undefined;
  selection: { startLine: number; endLine: number; text: string } | undefined;
}

export function buildPromptContext(ctx: BuildPromptContextArgs): string {
  // Current Phase 5-A keeps prompt context intentionally small:
  // project/file/selection metadata only. Richer injection belongs to later phases.
  const parts: string[] = [];
  parts.push(`Project: ${ctx.projectId}`);
  if (ctx.currentFile) parts.push(`Current file: ${ctx.currentFile}`);
  if (ctx.selection)
    parts.push(
      `Selection: lines ${ctx.selection.startLine}-${ctx.selection.endLine}`,
    );
  return parts.join('\n');
}
