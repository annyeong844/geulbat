import { resolve } from 'node:path';
import { Router, type Response } from 'express';
import { listTree } from '../../../daemon/files/list-tree.js';
import { readFile } from '../../../daemon/files/read-file.js';
import {
  createRawFileStream,
  UnsatisfiableRangeError,
} from '../../../daemon/files/read-raw-file.js';
import {
  replaceBinaryFile,
  replaceBinaryFileFromPath,
  saveBinaryFile,
  saveBinaryFileFromPath,
} from '../../../daemon/files/save-binary-file.js';
import { saveFile } from '../../../daemon/files/save-file.js';
import { normalizePath } from '../../../daemon/files/normalize-path.js';
import {
  ComputerDirectoryPickerError,
  type ComputerDirectoryPicker,
} from '../../../daemon/files/computer-directory-picker.js';
import {
  commitPreparedDeletion,
  commitPreparedDirectoryCreation,
  commitPreparedRelocation,
  prepareMutatingFilePath,
  prepareRelocationPaths,
} from '../../../daemon/files/file-mutation-chain.js';
import {
  claimFileBinaryInputRefPath,
  deleteFileBinaryInputRefPath,
  readFileBinaryInputRefPath,
  writeFileBinaryInputRefFromStream,
} from '../../../daemon/files/binary-input-ref-store.js';
import {
  readBodyString,
  readRequiredBodyStrings,
  readRequiredQueryString,
} from '#web/request/string-fields.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import { sendFilesRouteError } from '../protocol/map-errors.js';
import { registerInputRefDeleteRoute } from './input-ref-routes.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import type {
  ComputerDirectorySelectionResponse,
  ComputerFileRoot,
  ComputerFileScopeResponse,
  FileBinaryInputRefResponse,
} from '@geulbat/protocol/files';
import { isRecord, isString } from '../../../daemon/runtime-json.js';
import type { ComputerFileScope } from '../../../daemon/files/computer-file-scope.js';

type FilesRouteScopeArgs = {
  computerDirectoryPicker: ComputerDirectoryPicker;
  computerFileScope?: ComputerFileScope;
};
type ComputerFileBase = {
  root: ComputerFileRoot;
  basePath: string;
};
const logger = createLogger('web/files');

export function createFilesRoutes(args: FilesRouteScopeArgs): Router {
  const router = Router();

  router.get('/api/files/computer-scope', (_req, res) => {
    const response: ComputerFileScopeResponse = args.computerFileScope
      ? {
          available: true,
          ...(args.computerFileScope.browseStartPath === undefined
            ? {}
            : { browseStartPath: args.computerFileScope.browseStartPath }),
          browseShortcuts: args.computerFileScope.browseShortcuts.map(
            (shortcut) => ({ ...shortcut }),
          ),
        }
      : { available: false };
    res.status(200).json(response);
  });

  registerComputerDirectoryPickerRoute(router, args);
  registerFilesTreeRoute(router, args);
  registerFileReadRoute(router, args);
  registerFileRawReadRoute(router, args);
  registerTextFileSaveRoute(router, args);
  registerFileManageRoute(router, args);
  registerBinaryInputRefRoute(router, args);
  registerBinaryFileSaveRoute(router, args);
  registerBinaryFileReplaceRoute(router, args);

  return router;
}

function registerComputerDirectoryPickerRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.post('/api/files/select-directory', async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const scope = readComputerFileBaseOrSendError(
      res,
      { root: body['root'], projectId: body['projectId'] },
      scopeArgs,
    );
    if (scope === null) {
      return;
    }
    const rawInitialPath = body['initialPath'];
    if (rawInitialPath !== undefined && !isString(rawInitialPath)) {
      sendApiError(res, 'bad_request', 'initialPath must be a string');
      return;
    }

    const selectionAbort = new AbortController();
    const abortSelection = () => selectionAbort.abort();
    const abortSelectionWhenResponseCloses = () => {
      if (!res.writableEnded) {
        abortSelection();
      }
    };
    req.once('aborted', abortSelection);
    res.once('close', abortSelectionWhenResponseCloses);
    try {
      const initialPath =
        rawInitialPath ?? scopeArgs.computerFileScope?.browseStartPath ?? '';
      const normalizedInitialPath = normalizePath(scope.basePath, initialPath);
      const selection = await scopeArgs.computerDirectoryPicker.select({
        initialAbsolutePath: resolve(scope.basePath, normalizedInitialPath),
        signal: selectionAbort.signal,
      });
      if (selectionAbort.signal.aborted || res.destroyed) {
        return;
      }
      const response: ComputerDirectorySelectionResponse =
        selection.kind === 'cancelled'
          ? { status: 'cancelled' }
          : {
              status: 'selected',
              path: normalizePath(scope.basePath, selection.absolutePath),
            };
      res.status(200).json(response);
    } catch (error) {
      if (selectionAbort.signal.aborted || res.destroyed) {
        return;
      }
      if (error instanceof ComputerDirectoryPickerError) {
        sendApiError(
          res,
          error.code === 'unavailable' ? 'not_implemented' : 'execution_failed',
          error.message,
        );
        return;
      }
      sendFilesRouteError(res, 'files/select-directory', error);
    } finally {
      req.off('aborted', abortSelection);
      res.off('close', abortSelectionWhenResponseCloses);
    }
  });
}

// lazy 트리: 요청당 depth를 제한하고, 셸이 폴더 펼침 시 path로 하위를 다시
// 요청한다. 넓은 host coordinate base에서도 응답이
// 폭발하지 않도록 truncate 모드를 쓴다.
const TREE_DEFAULT_DEPTH = 4;
const TREE_MAX_DEPTH = 8;
const TREE_MAX_NODES = 4000;

function readTreeDepth(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return TREE_DEFAULT_DEPTH;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return TREE_DEFAULT_DEPTH;
  }
  return Math.min(parsed, TREE_MAX_DEPTH);
}

function registerFilesTreeRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.get('/api/files/tree', async (req, res) => {
    const request = readComputerFileBaseOrSendError(
      res,
      { root: req.query['root'], projectId: req.query['projectId'] },
      scopeArgs,
    );
    const subPath =
      typeof req.query['path'] === 'string' ? req.query['path'] : undefined;
    const depth = readTreeDepth(req.query['depth']);
    await respondWithRouteResult({
      res,
      request,
      logContext: 'files/tree',
      sendError: sendUnexpectedApiError,
      run: async (scope) => ({
        root: scope.root,
        tree: await listTree(scope.basePath, {
          // HTTP depth counts visible levels. listTree counts the requested
          // directory itself as depth zero, so one visible level maps to zero.
          maxDepth: depth - 1,
          maxNodes: TREE_MAX_NODES,
          depthLimitMode: 'truncate',
          ...(subPath !== undefined ? { subPath } : {}),
        }),
      }),
    });
  });
}

function registerFileReadRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.get('/api/files/read', async (req, res) => {
    const fileScope = readComputerFileBaseOrSendError(
      res,
      { root: req.query['root'], projectId: req.query['projectId'] },
      scopeArgs,
    );
    if (!fileScope) {
      return;
    }
    const pathResult = readRequiredQueryString(req.query['path'], 'path');
    if (!pathResult.ok) {
      sendApiError(res, 'bad_request', pathResult.message);
      return;
    }
    await respondWithRouteResult({
      res,
      request: pathResult.ok
        ? { workspaceRoot: fileScope.basePath, path: pathResult.value }
        : null,
      logContext: 'files/read',
      run: (request) => readFile(request.workspaceRoot, request.path),
    });
  });
}

const RAW_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
};

// 이미지/미디어 미리보기용 원본 바이트 — 텍스트 read와 같은 boundary
// 검증을 거치고 바이너리 거부만 없다. 스트리밍이라 크기 상한이 없고,
// HTTP Range를 지원해 <video>/<audio> 구간 탐색이 네이티브로 동작한다.
function registerFileRawReadRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.get('/api/files/raw', async (req, res) => {
    const fileScope = readComputerFileBaseOrSendError(
      res,
      { root: req.query['root'], projectId: req.query['projectId'] },
      scopeArgs,
    );
    if (!fileScope) {
      return;
    }
    const pathResult = readRequiredQueryString(req.query['path'], 'path');
    if (!pathResult.ok) {
      sendApiError(res, 'bad_request', pathResult.message);
      return;
    }
    const range = parseByteRangeHeader(req.headers.range);
    try {
      const result = await createRawFileStream(
        fileScope.basePath,
        pathResult.value,
        range ?? undefined,
      );
      const extension = pathResult.value.split('.').pop()?.toLowerCase() ?? '';
      res.setHeader(
        'Content-Type',
        RAW_CONTENT_TYPES[extension] ?? 'application/octet-stream',
      );
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', result.end - result.start + 1);
      if (range !== null) {
        res.status(206);
        res.setHeader(
          'Content-Range',
          `bytes ${result.start}-${result.end}/${result.totalSize}`,
        );
      }
      result.stream.on('error', () => {
        res.destroy();
      });
      result.stream.pipe(res);
    } catch (err: unknown) {
      if (range !== null && err instanceof UnsatisfiableRangeError) {
        res.status(416).setHeader('Content-Range', `bytes */${err.totalSize}`);
        res.end();
        return;
      }
      sendFilesRouteError(res, 'files/raw', err);
    }
  });
}

// "bytes=start-end" | "bytes=start-" 만 지원 — 그 외 형식은 전체 응답으로
// 폴백한다(suffix range, multi-range는 미디어 재생에 불필요)
function parseByteRangeHeader(
  header: string | undefined,
): { start: number; end?: number } | null {
  if (header === undefined) {
    return null;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (match === null || match[1] === undefined) {
    return null;
  }
  const start = Number.parseInt(match[1], 10);
  const end = match[2] === '' ? undefined : Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(start) || (end !== undefined && end < start)) {
    return null;
  }
  return end === undefined ? { start } : { start, end };
}

function registerTextFileSaveRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.post('/api/files/save', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const requestFields = readFileScopedBodyStringsOrSendError(
      res,
      body,
      ['path'] as const,
      scopeArgs,
    );
    // 빈 문자열 허용 — 새 파일 생성(create-only)은 빈 내용으로 시작한다
    const contentResult =
      requestFields === null ? null : readBodyString(body, 'content');
    if (contentResult && !contentResult.ok) {
      sendApiError(res, 'bad_request', contentResult.message);
      return;
    }
    const versionTokenResult =
      requestFields === null || contentResult === null || !contentResult.ok
        ? null
        : readBodyString(body, 'versionToken');
    if (versionTokenResult && !versionTokenResult.ok) {
      sendApiError(res, 'bad_request', versionTokenResult.message);
      return;
    }
    await respondWithRouteResult({
      res,
      request:
        requestFields &&
        contentResult !== null &&
        contentResult.ok &&
        versionTokenResult !== null &&
        versionTokenResult.ok
          ? {
              workspaceRoot: requestFields.workspaceRoot,
              path: requestFields.read('path'),
              content: contentResult.value,
              versionToken: versionTokenResult.value,
            }
          : null,
      logContext: 'files/save',
      run: (request) =>
        saveFile(
          request.workspaceRoot,
          request.path,
          request.content,
          request.versionToken,
        ),
    });
  });
}

const MANAGE_FILE_OPERATIONS = ['mkdir', 'delete', 'rename', 'move'] as const;
type ManageFileOperation = (typeof MANAGE_FILE_OPERATIONS)[number];

function isManageFileOperation(value: string): value is ManageFileOperation {
  return (MANAGE_FILE_OPERATIONS as readonly string[]).includes(value);
}

/**
 * User file ops shell input path (P7 spec §3.1.5) — agent의 manage_files
 * tool과 같은 mutation chain(file-mutation-chain)을 공유한다. user direct
 * gesture는 자체로 user-intent authorization이므로 approval 없이 커밋된다.
 */
function registerFileManageRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.post('/api/files/manage', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const requestFields = readFileScopedBodyStringsOrSendError(
      res,
      body,
      ['operation', 'path'] as const,
      scopeArgs,
    );
    if (requestFields === null) {
      return;
    }
    const operation = requestFields.read('operation');
    if (!isManageFileOperation(operation)) {
      sendApiError(
        res,
        'bad_request',
        'operation must be one of mkdir, delete, rename, move',
      );
      return;
    }
    let destination: string | undefined;
    if (operation === 'rename' || operation === 'move') {
      const destinationResult = readBodyString(body, 'destination');
      if (!destinationResult.ok) {
        sendApiError(res, 'bad_request', destinationResult.message);
        return;
      }
      destination = destinationResult.value;
    }
    await respondWithRouteResult({
      res,
      request: {
        workspaceRoot: requestFields.workspaceRoot,
        operation,
        path: requestFields.read('path'),
        destination,
      },
      logContext: 'files/manage',
      run: (request) => runManagedFileOperation(request),
    });
  });
}

async function runManagedFileOperation(request: {
  workspaceRoot: string;
  operation: ManageFileOperation;
  path: string;
  destination: string | undefined;
}): Promise<{
  ok: true;
  operation: string;
  path: string;
  destination?: string;
}> {
  const { workspaceRoot, operation, path, destination } = request;
  switch (operation) {
    case 'mkdir': {
      const prepared = await prepareMutatingFilePath(workspaceRoot, path, {
        allowMissingLeaf: true,
      });
      const result = await commitPreparedDirectoryCreation(prepared);
      return { ok: true, operation, path: result.path };
    }
    case 'delete': {
      const prepared = await prepareMutatingFilePath(workspaceRoot, path, {
        allowMissingLeaf: true,
      });
      const result = await commitPreparedDeletion(prepared);
      return { ok: true, operation, path: result.path };
    }
    case 'rename':
    case 'move': {
      if (destination === undefined) {
        throw new Error(`destination is required for ${operation}.`);
      }
      const prepared = await prepareRelocationPaths(
        workspaceRoot,
        path,
        destination,
      );
      const result = await commitPreparedRelocation(prepared);
      return {
        ok: true,
        operation,
        path: result.from,
        destination: result.to,
      };
    }
  }
}

function registerBinaryFileSaveRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.post('/api/files/save-binary', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const requestFields = readFileScopedBodyStringsOrSendError(
      res,
      body,
      ['path'] as const,
      scopeArgs,
    );
    const content =
      requestFields === null
        ? null
        : await readBinaryContentInputOrSendError(
            res,
            body,
            requestFields.workspaceRoot,
          );
    await respondWithRouteResult({
      res,
      request:
        requestFields && content
          ? {
              workspaceRoot: requestFields.workspaceRoot,
              path: requestFields.read('path'),
              content,
            }
          : null,
      logContext: 'files/save-binary',
      run: (request) =>
        saveBinaryFileWithInput(
          request.workspaceRoot,
          request.path,
          request.content,
        ),
    });
  });
}

function registerBinaryFileReplaceRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.post('/api/files/replace-binary', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const requestFields = readFileScopedBodyStringsOrSendError(
      res,
      body,
      ['path', 'versionToken'] as const,
      scopeArgs,
    );
    const content =
      requestFields === null
        ? null
        : await readBinaryContentInputOrSendError(
            res,
            body,
            requestFields.workspaceRoot,
          );
    await respondWithRouteResult({
      res,
      request:
        requestFields && content
          ? {
              workspaceRoot: requestFields.workspaceRoot,
              path: requestFields.read('path'),
              content,
              versionToken: requestFields.read('versionToken'),
            }
          : null,
      logContext: 'files/replace-binary',
      run: (request) =>
        replaceBinaryFileWithInput(
          request.workspaceRoot,
          request.path,
          request.content,
          request.versionToken,
        ),
    });
  });
}

function registerBinaryInputRefRoute(
  router: Router,
  scopeArgs: FilesRouteScopeArgs,
): void {
  router.post('/api/files/binary-inputs', async (req, res) => {
    if (req.is('application/json')) {
      sendApiError(
        res,
        'bad_request',
        'binary input upload must use a streaming content type',
      );
      return;
    }

    const fileScope = readComputerFileBaseOrSendError(
      res,
      { root: req.query['root'], projectId: req.query['projectId'] },
      scopeArgs,
    );
    if (!fileScope) {
      return;
    }

    try {
      const result = await writeFileBinaryInputRefFromStream({
        workspaceRoot: fileScope.basePath,
        input: req,
      });
      const response: FileBinaryInputRefResponse = {
        ok: true,
        ...result,
      };
      res.status(201).json(response);
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'files/binary-inputs', error);
    }
  });

  registerInputRefDeleteRoute({
    router,
    path: '/api/files/binary-inputs',
    resolveWorkspaceRoot: (req, res) =>
      readComputerFileBaseOrSendError(
        res,
        { root: req.query['root'], projectId: req.query['projectId'] },
        scopeArgs,
      )?.basePath ?? null,
    refQueryName: 'contentRef',
    logContext: 'files/binary-inputs/delete',
    readRefPath: ({ workspaceRoot, ref }) =>
      readFileBinaryInputRefPath({ workspaceRoot, contentRef: ref }),
    deleteRefPath: deleteFileBinaryInputRefPath,
  });
}

function readFileScopedBodyStringsOrSendError<const T extends string>(
  res: Response,
  body: Record<string, unknown> | undefined,
  names: readonly T[],
  args: FilesRouteScopeArgs,
): { workspaceRoot: string; read(name: T): string } | null {
  const fileScope = readComputerFileBaseOrSendError(
    res,
    { root: body?.['root'], projectId: body?.['projectId'] },
    args,
  );
  if (!fileScope) {
    return null;
  }
  const bodyResult = readRequiredBodyStrings(body, names);
  if (!bodyResult.ok) {
    sendApiError(res, 'bad_request', bodyResult.message);
    return null;
  }
  return {
    workspaceRoot: fileScope.basePath,
    read(name) {
      return bodyResult.read(name);
    },
  };
}

type BinaryContentInput =
  | { kind: 'buffer'; content: Buffer }
  | { kind: 'ref'; contentRef: string; path: string };

async function readBinaryContentInputOrSendError(
  res: Response,
  body: Record<string, unknown> | undefined,
  workspaceRoot: string,
): Promise<BinaryContentInput | null> {
  const mimeType = body?.['mimeType'];
  if (mimeType !== undefined && typeof mimeType !== 'string') {
    sendApiError(res, 'bad_request', 'mimeType must be a string');
    return null;
  }

  const hasContentBase64 = Object.hasOwn(body ?? {}, 'contentBase64');
  const hasContentRef = Object.hasOwn(body ?? {}, 'contentRef');
  if (hasContentBase64 === hasContentRef) {
    sendApiError(
      res,
      'bad_request',
      'exactly one of contentBase64 or contentRef is required',
    );
    return null;
  }

  if (hasContentRef) {
    const contentRef = body?.['contentRef'];
    if (typeof contentRef !== 'string') {
      sendApiError(res, 'bad_request', 'contentRef must be a string');
      return null;
    }
    const resolvedRef = await claimFileBinaryInputRefPath({
      workspaceRoot,
      contentRef,
    });
    if (!resolvedRef.ok) {
      sendApiError(res, resolvedRef.code, resolvedRef.message);
      return null;
    }
    return { kind: 'ref', contentRef, path: resolvedRef.path };
  }

  const contentBase64 = body?.['contentBase64'];
  if (typeof contentBase64 !== 'string') {
    sendApiError(res, 'bad_request', 'contentBase64 must be a string');
    return null;
  }
  const content = decodeBase64Body(contentBase64);
  if (!content) {
    sendApiError(res, 'bad_request', 'contentBase64 must be valid base64');
    return null;
  }
  return { kind: 'buffer', content };
}

function readComputerFileBaseOrSendError(
  res: Response,
  selector: { root: unknown; projectId: unknown },
  args: FilesRouteScopeArgs,
): ComputerFileBase | null {
  if (selector.projectId !== undefined) {
    sendApiError(res, 'bad_request', 'projectId is not supported');
    return null;
  }
  if (selector.root !== 'computer') {
    sendApiError(res, 'bad_request', 'root must be computer');
    return null;
  }
  if (args.computerFileScope === undefined) {
    sendApiError(res, 'not_found', 'computer filesystem is unavailable');
    return null;
  }
  return { root: 'computer', basePath: args.computerFileScope.root };
}

function decodeBase64Body(value: string): Buffer | null {
  if (value === '') {
    return Buffer.alloc(0);
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

async function saveBinaryFileWithInput(
  workspaceRoot: string,
  path: string,
  content: BinaryContentInput,
) {
  if (content.kind === 'buffer') {
    return saveBinaryFile(workspaceRoot, path, content.content);
  }
  try {
    return await saveBinaryFileFromPath(workspaceRoot, path, content.path);
  } finally {
    await deleteBinaryInputRefAfterUse(content);
  }
}

async function replaceBinaryFileWithInput(
  workspaceRoot: string,
  path: string,
  content: BinaryContentInput,
  versionToken: string,
) {
  if (content.kind === 'buffer') {
    return replaceBinaryFile(
      workspaceRoot,
      path,
      content.content,
      versionToken,
    );
  }
  try {
    return await replaceBinaryFileFromPath(
      workspaceRoot,
      path,
      content.path,
      versionToken,
    );
  } finally {
    await deleteBinaryInputRefAfterUse(content);
  }
}

async function deleteBinaryInputRefAfterUse(
  content: Extract<BinaryContentInput, { kind: 'ref' }>,
): Promise<void> {
  try {
    await deleteFileBinaryInputRefPath(content.path);
  } catch (error: unknown) {
    logger.warn('failed to delete consumed binary input reference:', {
      contentRef: content.contentRef,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function respondWithRouteResult<Request, Result>(args: {
  res: Response;
  request: Request | null;
  logContext: string;
  run: (request: Request) => Promise<Result>;
  sendError?: (res: Response, logContext: string, error: unknown) => void;
}): Promise<void> {
  const {
    res,
    request,
    logContext,
    run,
    sendError = sendFilesRouteError,
  } = args;
  if (!request) {
    return;
  }
  try {
    res.json(await run(request));
  } catch (error: unknown) {
    sendError(res, logContext, error);
  }
}
