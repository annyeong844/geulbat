import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createLogger } from '@geulbat/structured-logger/logger';
import type {
  GitReviewFileRequest,
  GitReviewFileResult,
  GitReviewFileSummary,
  GitReviewReleaseRequest,
  GitReviewReleaseResult,
  GitReviewSummaryRequest,
  GitReviewSummaryResult,
} from '@geulbat/protocol/git-review';

import {
  fetchGitReviewFile,
  fetchGitReviewSummary,
  releaseGitReviewObservation,
} from '../../lib/api/git-review.js';

const logger = createLogger('git-review');

type ChangedSummary = Extract<GitReviewSummaryResult, { kind: 'changed' }>;
type ReadyFile = Extract<GitReviewFileResult, { kind: 'ready' }>;
type FileIssue = Exclude<GitReviewFileResult, { kind: 'ready' }>;

export interface GitReviewClient {
  fetchSummary(
    request: GitReviewSummaryRequest,
    signal?: AbortSignal,
  ): Promise<GitReviewSummaryResult>;
  fetchFile(
    request: GitReviewFileRequest,
    signal?: AbortSignal,
  ): Promise<GitReviewFileResult>;
  release(
    request: GitReviewReleaseRequest,
    signal?: AbortSignal,
  ): Promise<GitReviewReleaseResult>;
}

const DEFAULT_CLIENT: GitReviewClient = {
  fetchSummary: fetchGitReviewSummary,
  fetchFile: fetchGitReviewFile,
  release: releaseGitReviewObservation,
};

interface GitReviewState {
  summary: GitReviewSummaryResult | null;
  summaryLoading: boolean;
  summaryLoadingMore: boolean;
  summaryError: string | null;
  selectedFileId: string | null;
  file: ReadyFile | null;
  fileIssue: FileIssue | null;
  fileLoading: boolean;
  fileLoadingMore: boolean;
  fileError: string | null;
}

export interface GitReviewController extends GitReviewState {
  changedSummary: ChangedSummary | null;
  selectedFile: GitReviewFileSummary | null;
  refresh: () => void;
  loadMoreSummary: () => void;
  selectFile: (fileId: string) => void;
  retrySelectedFile: () => void;
  loadMoreFile: () => void;
}

export interface UseGitReviewOptions {
  workingDirectory: string | null;
  reviewOpen: boolean;
  refreshGeneration: number;
  client?: GitReviewClient;
}

interface RefreshOptions {
  explicit: boolean;
  preserveSelection: boolean;
  captureSelected: boolean;
}

const INITIAL_STATE: GitReviewState = {
  summary: null,
  summaryLoading: false,
  summaryLoadingMore: false,
  summaryError: null,
  selectedFileId: null,
  file: null,
  fileIssue: null,
  fileLoading: false,
  fileLoadingMore: false,
  fileError: null,
};

export function useGitReview({
  workingDirectory,
  reviewOpen,
  refreshGeneration,
  client = DEFAULT_CLIENT,
}: UseGitReviewOptions): GitReviewController {
  const [state, setReactState] = useState<GitReviewState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const summaryGenerationRef = useRef(0);
  const fileGenerationRef = useRef(0);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const fileAbortRef = useRef<AbortController | null>(null);
  const observationIdRef = useRef<string | null>(null);
  const fileObservationIdRef = useRef<string | null>(null);
  const reviewOpenRef = useRef(reviewOpen);
  reviewOpenRef.current = reviewOpen;

  const updateState = useCallback(
    (update: (current: GitReviewState) => GitReviewState) => {
      const next = update(stateRef.current);
      stateRef.current = next;
      setReactState(next);
    },
    [],
  );

  const releaseFileObservation = useCallback(async () => {
    fileAbortRef.current?.abort();
    fileAbortRef.current = null;
    const observationId = observationIdRef.current;
    const fileObservationId = fileObservationIdRef.current;
    fileObservationIdRef.current = null;
    if (observationId === null || fileObservationId === null) {
      return;
    }
    try {
      await client.release({
        kind: 'file',
        observationId,
        fileObservationId,
      });
    } catch (error: unknown) {
      logger.warn('file observation release failed:', { error });
    }
  }, [client]);

  const releaseAllObservations = useCallback(async () => {
    summaryAbortRef.current?.abort();
    summaryAbortRef.current = null;
    await releaseFileObservation();
    const observationId = observationIdRef.current;
    observationIdRef.current = null;
    if (observationId === null) {
      return;
    }
    try {
      await client.release({ kind: 'summary', observationId });
    } catch (error: unknown) {
      logger.warn('summary observation release failed:', { error });
    }
  }, [client, releaseFileObservation]);

  const refreshSummaryRef = useRef<(options: RefreshOptions) => Promise<void>>(
    async () => undefined,
  );
  const captureFileRef = useRef<
    (
      summary: ChangedSummary,
      fileId: string,
      autoRefreshOnStale: boolean,
    ) => Promise<void>
  >(async () => undefined);

  const refreshSummary = useCallback(
    async (options: RefreshOptions) => {
      const previous = stateRef.current;
      const preservedSignature =
        options.preserveSelection && previous.summary?.kind === 'changed'
          ? fileSignature(
              previous.summary.files.items.find(
                (file) => file.fileId === previous.selectedFileId,
              ) ?? null,
            )
          : null;
      const generation = (summaryGenerationRef.current += 1);
      fileGenerationRef.current += 1;
      updateState(() => ({
        ...INITIAL_STATE,
        summaryLoading: workingDirectory !== null,
      }));
      await releaseAllObservations();
      if (
        generation !== summaryGenerationRef.current ||
        workingDirectory === null
      ) {
        return;
      }

      const controller = new AbortController();
      summaryAbortRef.current = controller;
      try {
        const result = await client.fetchSummary(
          { kind: 'start', workingDirectory },
          controller.signal,
        );
        if (generation !== summaryGenerationRef.current) {
          return;
        }
        summaryAbortRef.current = null;
        if (result.kind !== 'changed') {
          updateState(() => ({
            ...INITIAL_STATE,
            summary: result,
          }));
          return;
        }

        observationIdRef.current = result.observationId;
        const selectedFileId = selectRefreshedFileId(
          result.files.items,
          preservedSignature,
        );
        updateState(() => ({
          ...INITIAL_STATE,
          summary: result,
          selectedFileId,
        }));
        if (
          reviewOpenRef.current &&
          selectedFileId !== null &&
          options.captureSelected
        ) {
          void captureFileRef.current(result, selectedFileId, true);
        }
      } catch (error: unknown) {
        if (
          generation !== summaryGenerationRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        summaryAbortRef.current = null;
        updateState(() => ({
          ...INITIAL_STATE,
          summaryError: options.explicit
            ? '변경 사항을 불러오지 못했습니다.'
            : null,
        }));
      }
    },
    [client, releaseAllObservations, updateState, workingDirectory],
  );
  refreshSummaryRef.current = refreshSummary;

  const captureFile = useCallback(
    async (
      summary: ChangedSummary,
      fileId: string,
      autoRefreshOnStale: boolean,
    ) => {
      const summaryGeneration = summaryGenerationRef.current;
      const generation = (fileGenerationRef.current += 1);
      updateState((current) => ({
        ...current,
        selectedFileId: fileId,
        file: null,
        fileIssue: null,
        fileLoading: true,
        fileLoadingMore: false,
        fileError: null,
      }));
      await releaseFileObservation();
      if (
        summaryGeneration !== summaryGenerationRef.current ||
        generation !== fileGenerationRef.current ||
        observationIdRef.current !== summary.observationId
      ) {
        return;
      }
      const controller = new AbortController();
      fileAbortRef.current = controller;
      try {
        const result = await client.fetchFile(
          {
            kind: 'start',
            observationId: summary.observationId,
            fileId,
          },
          controller.signal,
        );
        if (
          summaryGeneration !== summaryGenerationRef.current ||
          generation !== fileGenerationRef.current
        ) {
          return;
        }
        fileAbortRef.current = null;
        if (result.kind === 'ready') {
          fileObservationIdRef.current = result.fileObservationId;
          updateState((current) => ({
            ...current,
            file: result,
            fileIssue: null,
            fileLoading: false,
          }));
          return;
        }
        updateState((current) => ({
          ...current,
          file: null,
          fileIssue: result,
          fileLoading: false,
        }));
        if (result.kind === 'stale' && autoRefreshOnStale) {
          void refreshSummaryRef.current({
            explicit: true,
            preserveSelection: true,
            captureSelected: false,
          });
        }
      } catch (error: unknown) {
        if (
          summaryGeneration !== summaryGenerationRef.current ||
          generation !== fileGenerationRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        fileAbortRef.current = null;
        updateState((current) => ({
          ...current,
          file: null,
          fileLoading: false,
          fileError: '파일 변경 내용을 불러오지 못했습니다.',
        }));
      }
    },
    [client, releaseFileObservation, updateState],
  );
  captureFileRef.current = captureFile;

  const loadMoreSummary = useCallback(() => {
    const current = stateRef.current;
    if (current.summary?.kind !== 'changed' || current.summaryLoadingMore) {
      return;
    }
    const baseSummary = current.summary;
    const cursor = baseSummary.files.nextCursor;
    if (cursor === null) {
      return;
    }
    const generation = summaryGenerationRef.current;
    updateState((value) => ({ ...value, summaryLoadingMore: true }));
    const controller = new AbortController();
    summaryAbortRef.current = controller;
    void (async () => {
      try {
        const result = await client.fetchSummary(
          {
            kind: 'continue',
            observationId: baseSummary.observationId,
            cursor,
          },
          controller.signal,
        );
        if (generation !== summaryGenerationRef.current) {
          return;
        }
        summaryAbortRef.current = null;
        if (
          result.kind !== 'changed' ||
          result.observationId !== baseSummary.observationId
        ) {
          updateState((value) => ({
            ...value,
            summaryLoadingMore: false,
            summaryError: '변경 목록이 갱신되어 다시 불러와야 합니다.',
          }));
          return;
        }
        updateState((value) => {
          if (
            value.summary?.kind !== 'changed' ||
            value.summary.observationId !== result.observationId
          ) {
            return value;
          }
          return {
            ...value,
            summary: {
              ...value.summary,
              files: {
                items: mergeSummaryFiles(
                  value.summary.files.items,
                  result.files.items,
                ),
                nextCursor: result.files.nextCursor,
              },
            },
            summaryLoadingMore: false,
          };
        });
      } catch (error: unknown) {
        if (
          generation !== summaryGenerationRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        summaryAbortRef.current = null;
        updateState((value) => ({
          ...value,
          summaryLoadingMore: false,
          summaryError: '변경 목록의 다음 페이지를 불러오지 못했습니다.',
        }));
      }
    })();
  }, [client, updateState]);

  const selectFile = useCallback(
    (fileId: string) => {
      const current = stateRef.current;
      if (current.summary?.kind !== 'changed') {
        return;
      }
      const file = current.summary.files.items.find(
        (candidate) => candidate.fileId === fileId,
      );
      if (file === undefined) {
        return;
      }
      void captureFile(current.summary, fileId, true);
    },
    [captureFile],
  );

  const retrySelectedFile = useCallback(() => {
    const current = stateRef.current;
    if (
      current.summary?.kind === 'changed' &&
      current.selectedFileId !== null
    ) {
      void captureFile(current.summary, current.selectedFileId, true);
    }
  }, [captureFile]);

  const loadMoreFile = useCallback(() => {
    const current = stateRef.current;
    if (
      current.summary?.kind !== 'changed' ||
      current.file === null ||
      current.fileLoadingMore
    ) {
      return;
    }
    const baseFile = current.file;
    const cursor = baseFile.rows.nextCursor;
    if (cursor === null) {
      return;
    }
    const summaryGeneration = summaryGenerationRef.current;
    const fileGeneration = fileGenerationRef.current;
    updateState((value) => ({ ...value, fileLoadingMore: true }));
    const controller = new AbortController();
    fileAbortRef.current = controller;
    void (async () => {
      try {
        const result = await client.fetchFile(
          {
            kind: 'continue',
            observationId: baseFile.observationId,
            fileId: baseFile.fileId,
            fileObservationId: baseFile.fileObservationId,
            cursor,
          },
          controller.signal,
        );
        if (
          summaryGeneration !== summaryGenerationRef.current ||
          fileGeneration !== fileGenerationRef.current
        ) {
          return;
        }
        fileAbortRef.current = null;
        if (result.kind !== 'ready') {
          updateState((value) => ({
            ...value,
            fileLoadingMore: false,
            fileIssue: result,
          }));
          return;
        }
        fileAbortRef.current = null;
        if (result.fileObservationId !== baseFile.fileObservationId) {
          updateState((value) => ({
            ...value,
            fileLoadingMore: false,
            fileError: '파일 변경 관찰이 바뀌어 다시 불러와야 합니다.',
          }));
          return;
        }
        updateState((value) => {
          if (
            value.file === null ||
            value.file.fileObservationId !== result.fileObservationId
          ) {
            return value;
          }
          return {
            ...value,
            file: {
              ...value.file,
              rows: {
                items: [...value.file.rows.items, ...result.rows.items],
                nextCursor: result.rows.nextCursor,
              },
            },
            fileLoadingMore: false,
          };
        });
      } catch (error: unknown) {
        if (
          summaryGeneration !== summaryGenerationRef.current ||
          fileGeneration !== fileGenerationRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        fileAbortRef.current = null;
        updateState((value) => ({
          ...value,
          fileLoadingMore: false,
          fileError: '파일 변경 내용의 다음 페이지를 불러오지 못했습니다.',
        }));
      }
    })();
  }, [client, updateState]);

  const refresh = useCallback(() => {
    void refreshSummary({
      explicit: true,
      preserveSelection: true,
      captureSelected: true,
    });
  }, [refreshSummary]);

  const previousReviewOpenRef = useRef(reviewOpen);
  useEffect(() => {
    const previous = previousReviewOpenRef.current;
    previousReviewOpenRef.current = reviewOpen;
    if (previous === reviewOpen) {
      return;
    }
    void refreshSummary({
      explicit: reviewOpen,
      preserveSelection: true,
      captureSelected: reviewOpen,
    });
  }, [refreshSummary, reviewOpen]);

  const previousRefreshGenerationRef = useRef(refreshGeneration);
  useEffect(() => {
    if (previousRefreshGenerationRef.current === refreshGeneration) {
      return;
    }
    previousRefreshGenerationRef.current = refreshGeneration;
    void refreshSummary({
      explicit: false,
      preserveSelection: reviewOpenRef.current,
      captureSelected: reviewOpenRef.current,
    });
  }, [refreshGeneration, refreshSummary]);

  useLayoutEffect(() => {
    void refreshSummary({
      explicit: false,
      preserveSelection: false,
      captureSelected: reviewOpenRef.current,
    });
  }, [refreshSummary]);

  useEffect(
    () => () => {
      summaryGenerationRef.current += 1;
      fileGenerationRef.current += 1;
      void releaseAllObservations();
    },
    [releaseAllObservations],
  );

  const changedSummary =
    state.summary?.kind === 'changed' ? state.summary : null;
  const selectedFile =
    changedSummary?.files.items.find(
      (file) => file.fileId === state.selectedFileId,
    ) ?? null;

  return {
    ...state,
    changedSummary,
    selectedFile,
    refresh,
    loadMoreSummary,
    selectFile,
    retrySelectedFile,
    loadMoreFile,
  };
}

export function fileSignature(
  file: GitReviewFileSummary | null,
): string | null {
  if (file === null) {
    return null;
  }
  return JSON.stringify(
    file.layers.map((layer) => [
      layer.comparison,
      layer.state,
      layer.beforeDisplayPath,
      layer.afterDisplayPath,
      layer.beforeContentKind,
      layer.afterContentKind,
    ]),
  );
}

function selectRefreshedFileId(
  files: GitReviewFileSummary[],
  preservedSignature: string | null,
): string | null {
  if (preservedSignature !== null) {
    const matches = files.filter(
      (file) => fileSignature(file) === preservedSignature,
    );
    if (matches.length === 1) {
      return matches[0]?.fileId ?? null;
    }
  }
  return files[0]?.fileId ?? null;
}

function mergeSummaryFiles(
  current: GitReviewFileSummary[],
  next: GitReviewFileSummary[],
): GitReviewFileSummary[] {
  const seen = new Set(current.map((file) => file.fileId));
  return [
    ...current,
    ...next.filter((file) => {
      if (seen.has(file.fileId)) {
        return false;
      }
      seen.add(file.fileId);
      return true;
    }),
  ];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
