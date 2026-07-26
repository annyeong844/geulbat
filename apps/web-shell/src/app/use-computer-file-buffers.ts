import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '@geulbat/structured-logger/logger';

import type { OpenFileTab } from '../features/editor/Editor.js';
import { tryParseJson } from '../lib/json.js';

const logger = createLogger('computer-files');
const RECENT_FILE_LIMIT = 4;
const RECENT_FILE_STORAGE_KEY = 'geulbat.shell.recent-files.v1';

interface TextFileBuffer {
  kind: 'text';
  path: string;
  content: string;
  versionToken: string;
  isDirty: boolean;
  lastSavedAt: number | null;
  extractedDocument?: 'docx' | 'xlsx' | 'hwpx';
}

export interface ComputerFileMediaPreview {
  kind: 'image' | 'audio' | 'video' | 'unsupported';
  url?: string;
  byteSize?: number;
}

interface MediaFileBuffer {
  kind: 'media';
  path: string;
  media: ComputerFileMediaPreview;
}

type FileBuffer = TextFileBuffer | MediaFileBuffer;

function readStoredRecentFiles(): string[] {
  try {
    const storage = globalThis.localStorage;
    if (typeof storage?.getItem !== 'function') {
      return [];
    }
    const raw = storage.getItem(RECENT_FILE_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = tryParseJson(raw);
    if (!parsed.ok || !Array.isArray(parsed.value)) {
      logger.warn('recent file persistence ignored invalid stored state');
      return [];
    }
    return [
      ...new Set(
        parsed.value.filter(
          (candidate): candidate is string =>
            typeof candidate === 'string' && candidate.length > 0,
        ),
      ),
    ].slice(0, RECENT_FILE_LIMIT);
  } catch (error: unknown) {
    logger.warn('recent file persistence load failed:', { error });
    return [];
  }
}

function storeRecentFiles(paths: string[]): void {
  try {
    const storage = globalThis.localStorage;
    if (typeof storage?.setItem !== 'function') {
      return;
    }
    storage.setItem(RECENT_FILE_STORAGE_KEY, JSON.stringify(paths));
  } catch (error: unknown) {
    logger.warn('recent file persistence save failed:', { error });
  }
}

function revokeMediaUrl(buffer: FileBuffer): void {
  if (buffer.kind === 'media' && buffer.media.url?.startsWith('blob:')) {
    URL.revokeObjectURL(buffer.media.url);
  }
}

function remapPath(
  candidate: string,
  path: string,
  destination: string,
): string {
  if (candidate === path) {
    return destination;
  }
  return candidate.startsWith(`${path}/`)
    ? `${destination}${candidate.slice(path.length)}`
    : candidate;
}

export function useComputerFileBuffers() {
  const [buffers, setBuffers] = useState<FileBuffer[]>([]);
  const buffersForCleanupRef = useRef<FileBuffer[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [recentFilePaths, setRecentFiles] = useState(readStoredRecentFiles);

  useEffect(() => {
    buffersForCleanupRef.current = buffers;
  }, [buffers]);

  useEffect(
    () => () => {
      for (const buffer of buffersForCleanupRef.current) {
        revokeMediaUrl(buffer);
      }
    },
    [],
  );

  const rememberRecentFile = useCallback((path: string) => {
    setRecentFiles((previous) => {
      const next = [
        path,
        ...previous.filter((candidate) => candidate !== path),
      ].slice(0, RECENT_FILE_LIMIT);
      storeRecentFiles(next);
      return next;
    });
  }, []);

  const removeRecentFile = useCallback((path: string) => {
    setRecentFiles((previous) => {
      const next = previous.filter((candidate) => candidate !== path);
      storeRecentFiles(next);
      return next;
    });
  }, []);

  const upsertBuffer = useCallback((next: FileBuffer) => {
    setBuffers((previous) => {
      const index = previous.findIndex((buffer) => buffer.path === next.path);
      if (index < 0) {
        return [...previous, next];
      }
      const replaced = previous[index];
      if (replaced && replaced !== next) {
        revokeMediaUrl(replaced);
      }
      const copy = [...previous];
      copy[index] = next;
      return copy;
    });
  }, []);

  const patchTextBuffer = useCallback(
    (path: string, patch: Partial<Omit<TextFileBuffer, 'kind' | 'path'>>) => {
      setBuffers((previous) =>
        previous.map((buffer) =>
          buffer.path === path && buffer.kind === 'text'
            ? { ...buffer, ...patch }
            : buffer,
        ),
      );
    },
    [],
  );

  const openTextBuffer = useCallback(
    (next: Omit<TextFileBuffer, 'kind'>) => {
      upsertBuffer({ kind: 'text', ...next });
      rememberRecentFile(next.path);
      setActivePath(next.path);
    },
    [rememberRecentFile, upsertBuffer],
  );

  const replaceTextBuffer = useCallback(
    (next: Omit<TextFileBuffer, 'kind'>) => {
      upsertBuffer({ kind: 'text', ...next });
    },
    [upsertBuffer],
  );

  const openMediaBuffer = useCallback(
    (path: string, media: ComputerFileMediaPreview) => {
      upsertBuffer({ kind: 'media', path, media });
      rememberRecentFile(path);
      setActivePath(path);
    },
    [rememberRecentFile, upsertBuffer],
  );

  const hasBuffer = useCallback(
    (path: string) => buffers.some((buffer) => buffer.path === path),
    [buffers],
  );

  const activateBuffer = useCallback(
    (path: string) => {
      rememberRecentFile(path);
      setActivePath(path);
    },
    [rememberRecentFile],
  );

  const closeBuffer = useCallback(
    (path: string) => {
      setBuffers((previous) => {
        const index = previous.findIndex((buffer) => buffer.path === path);
        if (index < 0) {
          return previous;
        }
        const closed = previous[index];
        if (closed) {
          revokeMediaUrl(closed);
        }
        const next = previous.filter((buffer) => buffer.path !== path);
        if (activePath === path) {
          const neighbor = next[Math.min(index, next.length - 1)];
          setActivePath(neighbor ? neighbor.path : null);
        }
        return next;
      });
    },
    [activePath],
  );

  const removeManagedPath = useCallback((path: string) => {
    setBuffers((previous) =>
      previous.filter((buffer) => {
        const removed =
          buffer.path === path || buffer.path.startsWith(`${path}/`);
        if (removed) {
          revokeMediaUrl(buffer);
        }
        return !removed;
      }),
    );
    setActivePath((previous) =>
      previous !== null &&
      (previous === path || previous.startsWith(`${path}/`))
        ? null
        : previous,
    );
    setRecentFiles((previous) => {
      const next = previous.filter(
        (recentPath) =>
          recentPath !== path && !recentPath.startsWith(`${path}/`),
      );
      storeRecentFiles(next);
      return next;
    });
  }, []);

  const remapManagedPath = useCallback((path: string, destination: string) => {
    const remap = (candidate: string) =>
      remapPath(candidate, path, destination);
    setBuffers((previous) =>
      previous.map((buffer) => ({
        ...buffer,
        path: remap(buffer.path),
      })),
    );
    setActivePath((previous) =>
      previous === null ? previous : remap(previous),
    );
    setRecentFiles((previous) => {
      const next = previous.map(remap);
      storeRecentFiles(next);
      return next;
    });
  }, []);

  const activeBuffer = buffers.find((buffer) => buffer.path === activePath);
  const activeTextBuffer =
    activeBuffer?.kind === 'text' ? activeBuffer : undefined;
  const binaryPreview =
    activeBuffer?.kind === 'media'
      ? { path: activeBuffer.path, ...activeBuffer.media }
      : null;
  const openFiles = buffers.map(
    (buffer): OpenFileTab => ({
      path: buffer.path,
      isDirty: buffer.kind === 'text' && buffer.isDirty,
    }),
  );

  return {
    activePath,
    activeTextBuffer,
    binaryPreview,
    recentFilePaths,
    openFiles,
    hasBuffer,
    openTextBuffer,
    replaceTextBuffer,
    openMediaBuffer,
    activateBuffer,
    closeBuffer,
    patchTextBuffer,
    removeRecentFile,
    removeManagedPath,
    remapManagedPath,
  };
}
