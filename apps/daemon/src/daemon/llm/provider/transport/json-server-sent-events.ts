export async function* iterateJsonServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const drained = drainSseBlocks(buffer);
      buffer = drained.remainder;
      for (const block of drained.blocks) {
        const event = parseJsonSseBlock(block);
        if (event === 'done') {
          completed = true;
          return;
        }
        if (event !== undefined) {
          yield event;
        }
      }
    }
    if (buffer.trim() !== '') {
      const event = parseJsonSseBlock(buffer);
      if (event !== undefined && event !== 'done') {
        yield event;
      }
    }
    completed = true;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The owned response stream is already closing; cancellation is best-effort.
      }
    }
    reader.releaseLock();
  }
}

function drainSseBlocks(value: string): {
  blocks: string[];
  remainder: string;
} {
  const normalized = value.replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return {
    blocks: parts.slice(0, -1),
    remainder: parts.at(-1) ?? '',
  };
}

function parseJsonSseBlock(
  block: string,
): Record<string, unknown> | 'done' | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data === '') {
    return undefined;
  }
  if (data === '[DONE]') {
    return 'done';
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error('JSON SSE stream contains invalid JSON');
  }
  if (!isRecord(value)) {
    throw new Error('JSON SSE stream contains a non-object event');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
