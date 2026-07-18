interface BuildPromptContextArgs {
  currentFile: string | undefined;
  selection: { startLine: number; endLine: number; text: string } | undefined;
}

export function buildPromptContext(ctx: BuildPromptContextArgs): string {
  const currentFile = ctx.currentFile?.trim();
  return [
    '<file-context>',
    `Current file: ${currentFile ? normalizePromptPath(currentFile) : 'none'}`,
    `Selection: ${
      ctx.selection
        ? `lines ${ctx.selection.startLine}-${ctx.selection.endLine}`
        : 'none'
    }`,
    '</file-context>',
  ].join('\n');
}

function normalizePromptPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/u, '');
}
