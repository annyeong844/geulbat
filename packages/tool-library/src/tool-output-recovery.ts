export async function collectToolOutputPages(args: {
  outputRef: string;
  pageLimit: number;
  readPage(request: {
    outputRef: string;
    offset: number;
    limit: number;
  }): Promise<unknown>;
}): Promise<{
  outputRef: string;
  content: string;
  totalChars: number;
  pageCount: number;
}> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  function fail(message: string): never {
    const error = new Error(`Tool output recovery failed: ${message}`);
    error.name = 'ToolOutputRecoveryError';
    Object.assign(error, { errorCode: 'tool_output_recovery_failed' });
    throw error;
  }

  if (
    args === null ||
    typeof args !== 'object' ||
    typeof args.outputRef !== 'string' ||
    args.outputRef.trim().length === 0
  ) {
    fail('outputRef must be a non-empty string');
  }
  if (!Number.isSafeInteger(args.pageLimit) || args.pageLimit < 1) {
    fail('pageLimit must be a positive safe integer');
  }
  if (typeof args.readPage !== 'function') {
    fail('readPage must be a function');
  }

  const chunks: string[] = [];
  let offset = 0;
  let totalChars: number | undefined;
  let pageCount = 0;

  for (;;) {
    const value = await args.readPage({
      outputRef: args.outputRef,
      offset,
      limit: args.pageLimit,
    });
    pageCount += 1;
    if (!isRecord(value)) {
      fail('readPage did not return a page object');
    }
    if (value['ok'] !== true) {
      fail('readPage did not return a successful page');
    }

    const pageOutputRef = value['outputRef'];
    const pageOffset = value['offset'];
    const pageLimit = value['limit'];
    const endOffset = value['endOffset'];
    const pageTotalChars = value['totalChars'];
    const hasMore = value['hasMore'];
    const nextOffset = value['nextOffset'];
    const content = value['content'];
    if (
      pageOutputRef !== args.outputRef ||
      pageOffset !== offset ||
      pageLimit !== args.pageLimit ||
      typeof endOffset !== 'number' ||
      !Number.isSafeInteger(endOffset) ||
      typeof pageTotalChars !== 'number' ||
      !Number.isSafeInteger(pageTotalChars) ||
      typeof hasMore !== 'boolean' ||
      typeof content !== 'string'
    ) {
      fail('page metadata does not match the requested range');
    }
    if (endOffset < offset || pageTotalChars < endOffset) {
      fail('page offsets are outside the declared output length');
    }
    if (endOffset !== offset + content.length) {
      fail('page content length does not match its offsets');
    }
    if (totalChars === undefined) {
      totalChars = pageTotalChars;
    } else if (pageTotalChars !== totalChars) {
      fail('totalChars changed between pages');
    }
    const declaredTotalChars = totalChars;
    if (declaredTotalChars === undefined) {
      fail('page did not declare totalChars');
    }

    chunks.push(content);
    if (!hasMore) {
      if (nextOffset !== null || endOffset !== declaredTotalChars) {
        fail('terminal page does not end at totalChars');
      }
      const collected = chunks.join('');
      if (collected.length !== declaredTotalChars) {
        fail('collected content length does not match totalChars');
      }
      return {
        outputRef: args.outputRef,
        content: collected,
        totalChars: declaredTotalChars,
        pageCount,
      };
    }

    if (
      typeof nextOffset !== 'number' ||
      !Number.isSafeInteger(nextOffset) ||
      nextOffset !== endOffset ||
      nextOffset <= offset ||
      nextOffset >= declaredTotalChars
    ) {
      fail('non-terminal page did not advance to the next range');
    }
    offset = nextOffset;
  }
}

export function buildToolOutputCollectorRuntimeExpression(): string {
  return `(${collectToolOutputPages.toString()})`;
}
