import { createReadStream } from 'node:fs';

import { randomUUID } from 'node:crypto';

import { Router, type Request, type Response } from 'express';
import {
  isArtifactDraftCommitRequest,
  isThreadMediaRef,
  type ArtifactDraftCommitResponse,
} from '@geulbat/protocol/artifacts';
import { isThreadId, type ThreadId } from '@geulbat/protocol/ids';
import { resolveRunModelDescriptor } from '@geulbat/protocol/run-contract';
import type { ThreadMessageAttachment } from '@geulbat/protocol/thread-metadata';
import { isPrepareProviderTransitionRequest } from '@geulbat/protocol/threads';
import { isRecord } from '../../../daemon/runtime-json.js';
import { statThreadMediaFile } from '../../../daemon/sessions/media-file-store.js';
import { branchThreadSession } from '../../../daemon/sessions/branch-thread.js';
import { deleteThreadSession } from '../../../daemon/sessions/delete-thread.js';
import {
  commitThreadArtifactUpdateVersion,
  isArtifactStoreCorruptionError,
} from '../../../daemon/sessions/artifact-store.js';
import { loadThreadIndex } from '../../../daemon/sessions/threads-index.js';
import { loadThreadDetailSnapshot } from '../../../daemon/sessions/thread-detail.js';
import { readRunAttachment } from '../../../daemon/sessions/run-attachment-store.js';
import {
  isTranscriptCorruptionError,
  readTranscriptEntries,
} from '../../../daemon/sessions/transcript-log.js';
import type {
  ActiveThreadRunLookup,
  ThreadsRoutesContext,
} from './routes-context.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

export function createThreadsRoutes(args: {
  context: ThreadsRoutesContext;
}): Router {
  const {
    activeRuns,
    backgroundNotifications,
    homeStateRoot,
    providerTransitionCompaction,
  } = args.context;
  return createThreadsRoutesInternal({
    activeRuns,
    backgroundNotifications,
    homeStateRoot,
    providerTransitionCompaction,
  });
}

function createThreadsRoutesInternal(args: {
  activeRuns: ActiveThreadRunLookup;
  backgroundNotifications: ThreadsRoutesContext['backgroundNotifications'];
  homeStateRoot: string;
  providerTransitionCompaction: ThreadsRoutesContext['providerTransitionCompaction'];
}): Router {
  const router = Router();
  const {
    activeRuns,
    backgroundNotifications,
    homeStateRoot,
    providerTransitionCompaction,
  } = args;

  router.get('/api/threads', async (_req, res) => {
    try {
      res.json({ threads: await loadThreadIndex(homeStateRoot) });
    } catch (err: unknown) {
      sendUnexpectedApiError(res, 'threads/list', err);
    }
  });

  router.get('/api/threads/:threadId', async (req, res) => {
    const threadId = readThreadIdOrSendError(req, res);
    if (!threadId) {
      return;
    }

    try {
      res.json(
        await loadThreadDetailSnapshot({
          workspaceRoot: homeStateRoot,
          threadId,
        }),
      );
    } catch (err: unknown) {
      if (isTranscriptCorruptionError(err)) {
        sendApiError(res, 'internal', 'thread transcript is corrupted');
        return;
      }
      if (isArtifactStoreCorruptionError(err)) {
        sendApiError(res, 'internal', 'thread artifact store is corrupted');
        return;
      }
      sendUnexpectedApiError(res, 'threads/detail', err);
    }
  });

  // 첨부 원본 바이트 — 대화창 이미지 렌더링용. 바이트는 불변이라 장기 캐시.
  router.get(
    '/api/threads/:threadId/attachments/:attachmentId',
    async (req, res) => {
      const threadId = readThreadIdOrSendError(req, res);
      if (!threadId) {
        return;
      }
      const attachmentId = req.params['attachmentId'] ?? '';

      try {
        const record = await findThreadAttachmentRecord(
          homeStateRoot,
          threadId,
          attachmentId,
        );
        const bytes = record
          ? await readRunAttachment({
              workspaceRoot: homeStateRoot,
              threadId,
              attachmentId: record.attachmentId,
            })
          : null;
        if (!record || !bytes) {
          sendApiError(
            res,
            'not_found',
            `attachment not found: ${attachmentId}`,
          );
          return;
        }
        const contentType = resolveAttachmentResponseContentType(
          record.mimeType,
        );
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        if (contentType !== 'application/pdf') {
          // 첨부는 사용자 제어 바이트다 — 문서로 해석돼도(특히 SVG) 앱
          // origin에서 스크립트가 돌지 않게 격리한다. <img>/텍스트 인라인
          // 보기에는 영향이 없고, PDF만 내장 뷰어 호환을 위해 제외한다.
          res.setHeader('Content-Security-Policy', 'sandbox');
        }
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.send(bytes);
      } catch (err: unknown) {
        sendUnexpectedApiError(res, 'threads/attachment', err);
      }
    },
  );

  // 스레드 media 파일(video-generation-open §4.6) — sha 주소라 불변 캐시,
  // <video> 시킹을 위해 Range(단일 구간)를 지원한다. mediaRef 형식 가드가
  // 경로 탈출을 원천 차단하고, 타 스레드 파일은 경로 격리로 404가 된다.
  router.get('/api/threads/:threadId/media/:mediaRef', async (req, res) => {
    const threadId = readThreadIdOrSendError(req, res);
    if (!threadId) {
      return;
    }
    const mediaRef = req.params['mediaRef'] ?? '';
    if (!isThreadMediaRef(mediaRef)) {
      sendApiError(res, 'bad_request', 'invalid media ref');
      return;
    }

    try {
      const media = await statThreadMediaFile({
        workspaceRoot: homeStateRoot,
        threadId,
        mediaRef,
      });
      if (!media) {
        sendApiError(res, 'not_found', `media not found: ${mediaRef}`);
        return;
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', resolveMediaContentType(mediaRef));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

      const range = parseSingleByteRange(req.headers.range, media.byteLength);
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${media.byteLength}`);
        res.status(416).end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? media.byteLength - 1;
      if (range) {
        res.status(206);
        res.setHeader(
          'Content-Range',
          `bytes ${start}-${end}/${media.byteLength}`,
        );
      }
      res.setHeader('Content-Length', String(end - start + 1));
      const fileStream = createReadStream(media.path, { start, end });
      fileStream.on('error', () => {
        res.destroy();
      });
      fileStream.pipe(res);
    } catch (err: unknown) {
      sendUnexpectedApiError(res, 'threads/media', err);
    }
  });

  router.post(
    '/api/threads/:threadId/provider-transition',
    async (req, res) => {
      const threadId = readThreadIdOrSendError(req, res);
      if (!threadId) {
        return;
      }
      const requestBody: unknown = req.body;
      if (!isPrepareProviderTransitionRequest(requestBody)) {
        sendApiError(
          res,
          'invalid_args',
          'invalid provider transition request',
        );
        return;
      }

      const source = resolveRunModelDescriptor(requestBody.sourceModelId);
      const target = resolveRunModelDescriptor(requestBody.targetModelId);
      if (
        !source.reasoningEfforts.some(
          (effort) => effort === requestBody.reasoningEffort,
        )
      ) {
        sendApiError(
          res,
          'invalid_args',
          'reasoning effort is unavailable for the source model',
        );
        return;
      }
      if (source.providerId === target.providerId) {
        res.json({
          ok: true,
          status: 'not_needed',
          threadId,
          sourceModelId: source.id,
          targetModelId: target.id,
        });
        return;
      }

      const activeRun = activeRuns.getRunByThreadId(threadId);
      if (activeRun) {
        sendApiError(
          res,
          'conflict_active_run',
          `thread ${threadId} has an active run`,
          { threadId, activeRunId: activeRun.runId },
        );
        return;
      }

      const result = await providerTransitionCompaction.prepare({
        workspaceRoot: homeStateRoot,
        threadId,
        source: { providerId: source.providerId, model: source.id },
        target: { providerId: target.providerId, model: target.id },
        reasoningEffort: requestBody.reasoningEffort,
      });
      if (result.kind === 'not_needed') {
        res.json({
          ok: true,
          status: 'not_needed',
          threadId,
          sourceModelId: source.id,
          targetModelId: target.id,
        });
        return;
      }
      if (result.kind === 'compacted') {
        res.json({
          ok: true,
          status: 'compacted',
          threadId,
          sourceModelId: source.id,
          targetModelId: target.id,
          compactionEntryId: result.compactionEntryId,
        });
        return;
      }

      sendApiError(
        res,
        result.reason === 'stale_snapshot'
          ? 'conflict'
          : result.reason === 'same_provider'
            ? 'invalid_args'
            : 'execution_failed',
        result.message,
      );
    },
  );

  // 사용자 draft → 버전 커밋 — 에디터 </>에서 고친 내용을 같은 artifactId의
  // 새 버전으로 append한다 (phase5 commit path spec §5.2 update contract).
  // baseVersion 불일치는 409 conflict + latestVersion으로 돌려 UI가 최신
  // 버전을 다시 로드하게 한다. run 밖 사용자 편집이므로 createdByRunId는
  // user-edit 마커다.
  router.post(
    '/api/threads/:threadId/artifacts/:artifactId/versions',
    async (req, res) => {
      const threadId = readThreadIdOrSendError(req, res);
      if (!threadId) {
        return;
      }
      const artifactId = req.params.artifactId;
      if (typeof artifactId !== 'string' || artifactId.trim() === '') {
        sendApiError(res, 'invalid_args', 'artifactId is required');
        return;
      }
      if (!isArtifactDraftCommitRequest(req.body)) {
        sendApiError(
          res,
          'invalid_args',
          'body must be { baseVersion: number>=1, payload: non-empty string }',
        );
        return;
      }

      try {
        const committed = await commitThreadArtifactUpdateVersion({
          workspaceRoot: homeStateRoot,
          threadId,
          artifactId,
          baseVersion: req.body.baseVersion,
          payload: req.body.payload,
          createdByRunId: `user-edit-${randomUUID()}`,
          timestamp: new Date().toISOString(),
        });
        if (!committed.ok) {
          if (committed.reason === 'version_conflict') {
            sendApiError(
              res,
              'conflict_stale_write',
              `artifact ${artifactId} is at version ${committed.latestVersion}; reload before committing`,
              { latestVersion: committed.latestVersion },
            );
            return;
          }
          // artifact_not_found — 이 route는 expectedRenderer를 넘기지 않아
          // renderer_mismatch가 나올 수 없지만, 타입상 not_found로 합류시킨다.
          sendApiError(res, 'not_found', `artifact not found: ${artifactId}`);
          return;
        }
        const response: ArtifactDraftCommitResponse = {
          ok: true,
          artifact: {
            ...committed.version,
            title: committed.artifact.title ?? null,
            persistenceEpoch: committed.artifact.persistenceEpoch,
            sourceRef: committed.artifact.sourceRef ?? null,
          },
          ref: committed.ref,
        };
        res.json(response);
      } catch (err: unknown) {
        if (isArtifactStoreCorruptionError(err)) {
          sendApiError(res, 'internal', 'thread artifact store is corrupted');
          return;
        }
        sendUnexpectedApiError(res, 'threads/artifact-version-commit', err);
      }
    },
  );

  // 스레드 브랜치 — upToEntryId 포함 prefix를 복제한 새 스레드를 만든다.
  // 원 스레드는 불변이므로 active run이 있어도 안전하다(디스크에 settle된
  // 엔트리까지만 스냅샷 복사).
  router.post('/api/threads/:threadId/branch', async (req, res) => {
    const threadId = readThreadIdOrSendError(req, res);
    if (!threadId) {
      return;
    }

    const upToEntryId = readOptionalUpToEntryId(req.body);
    if (!upToEntryId.ok) {
      sendApiError(res, 'invalid_args', upToEntryId.message);
      return;
    }

    try {
      const branched = await branchThreadSession({
        workspaceRoot: homeStateRoot,
        sourceThreadId: threadId,
        ...(upToEntryId.value !== undefined
          ? { upToEntryId: upToEntryId.value }
          : {}),
      });
      if (!branched.ok) {
        sendApiError(res, 'not_found', branched.message);
        return;
      }
      res.json({
        ok: true,
        threadId: branched.threadId,
        sourceThreadId: threadId,
        copiedMessageCount: branched.copiedMessageCount,
      });
    } catch (err: unknown) {
      if (isTranscriptCorruptionError(err)) {
        sendApiError(res, 'internal', 'thread transcript is corrupted');
        return;
      }
      sendUnexpectedApiError(res, 'threads/branch', err);
    }
  });

  router.delete('/api/threads/:threadId', async (req, res) => {
    const threadId = readThreadIdOrSendError(req, res);
    if (!threadId) {
      return;
    }

    const activeRun = activeRuns.getRunByThreadId(threadId);
    if (activeRun) {
      sendApiError(
        res,
        'conflict_active_run',
        `thread ${threadId} has an active run`,
        { threadId, activeRunId: activeRun.runId },
      );
      return;
    }

    try {
      const deleted = await deleteThreadSession(homeStateRoot, threadId);
      if (!deleted) {
        sendApiError(res, 'not_found', `thread not found: ${threadId}`);
        return;
      }
      backgroundNotifications.clearThreadBackgroundResults(threadId);
      res.json({ ok: true, threadId });
    } catch (err: unknown) {
      sendUnexpectedApiError(res, 'threads/delete', err);
    }
  });

  return router;
}

// 인라인 렌더는 스크립트가 돌지 않는 형식만 원래 MIME으로 내보낸다.
// text kind의 저장 바이트는 추출 텍스트이므로 text/plain이 의미상으로도
// 정확하다 — 업로드된 text/html을 그대로 돌려주면 앱 origin에서 사용자
// HTML이 렌더된다(XSS).
// mediaRef 확장자는 isThreadMediaRef 가드를 통과한 폐쇄 집합이다
const MEDIA_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function resolveMediaContentType(mediaRef: string): string {
  const extension = mediaRef.slice(mediaRef.lastIndexOf('.') + 1);
  return (
    MEDIA_CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
  );
}

// 단일 구간 Range만 지원(멀티파트 구간은 <video> 시킹에 불필요 — 전체 응답
// 으로 폴백). 형식 오류도 폴백, 범위 밖 시작점만 416(unsatisfiable)이다.
function parseSingleByteRange(
  header: string | undefined,
  byteLength: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    return null;
  }
  if (match[1] === '') {
    // suffix range: 마지막 N바이트
    const suffixLength = Number(match[2]);
    if (suffixLength === 0) {
      return 'unsatisfiable';
    }
    const start = Math.max(0, byteLength - suffixLength);
    return { start, end: byteLength - 1 };
  }
  const start = Number(match[1]);
  if (start >= byteLength) {
    return 'unsatisfiable';
  }
  const end =
    match[2] === ''
      ? byteLength - 1
      : Math.min(Number(match[2]), byteLength - 1);
  if (end < start) {
    return null;
  }
  return { start, end };
}

function resolveAttachmentResponseContentType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === 'application/pdf') {
    return normalized;
  }
  if (normalized.startsWith('image/')) {
    return normalized;
  }
  return 'text/plain; charset=utf-8';
}

// 트랜스크립트 메타데이터에서 첨부 레코드를 찾는다 — 트랜스크립트에 없는
// id는 서빙하지 않는다(스토어 직접 열람 차단).
async function findThreadAttachmentRecord(
  workspaceRoot: string,
  threadId: string,
  attachmentId: string,
): Promise<ThreadMessageAttachment | null> {
  if (!attachmentId) {
    return null;
  }
  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  for (const entry of entries) {
    if (entry.role !== 'user' || !entry.metadata) {
      continue;
    }
    const metadata = entry.metadata;
    if (!('attachments' in metadata) || !metadata.attachments) {
      continue;
    }
    const record = metadata.attachments.find(
      (attachment) => attachment.attachmentId === attachmentId,
    );
    if (record) {
      return record;
    }
  }
  return null;
}

function readOptionalUpToEntryId(
  body: unknown,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (body === undefined || body === null) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(body)) {
    return { ok: false, message: 'branch request body must be an object' };
  }
  const upToEntryId = body['upToEntryId'];
  if (upToEntryId === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof upToEntryId !== 'string' || upToEntryId.trim() === '') {
    return {
      ok: false,
      message: 'upToEntryId must be a non-empty string when present',
    };
  }
  return { ok: true, value: upToEntryId };
}
function readThreadIdOrSendError(req: Request, res: Response): ThreadId | null {
  const threadId = req.params['threadId'];
  if (typeof threadId !== 'string' || threadId.length === 0) {
    sendApiError(res, 'bad_request', 'threadId is required');
    return null;
  }
  if (!isThreadId(threadId)) {
    sendApiError(res, 'bad_request', 'invalid threadId');
    return null;
  }

  return threadId;
}
