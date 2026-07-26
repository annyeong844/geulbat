import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadId } from '@geulbat/protocol/ids';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ArtifactDurabilitySourceAuthority } from './artifact-durability-source-authority.js';

import {
  createArtifactDurabilityIntentSnapshotId,
  createArtifactDurabilitySourceAuthorityKey,
} from './artifact-durability.js';
import {
  sanitizeGeneratedBinaryExportSnapshot,
  sanitizeGeneratedTextExportFileNameHint,
  sanitizeGeneratedTextExportSnapshot,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
} from './artifact-types.js';

const FILE_MUTATION_ALLOWED_TOOLS = [
  'read_file',
  'write_file',
  'apply_patch',
] as const;

type ResolvedArtifactSourceAuthority = ArtifactDurabilitySourceAuthority;

export function buildArtifactApplyRunDraftFromAuthority(args: {
  artifact: ThreadArtifactVersion;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
}): RunRequest | null {
  const artifact = args.artifact;
  const sourceAuthority = args.sourceAuthority;
  if (
    artifact.renderer !== 'markdown' ||
    !sourceAuthority ||
    sourceAuthority.filePath === null
  ) {
    return null;
  }
  const intentSnapshotId = createArtifactDurabilityIntentSnapshotId({
    action: 'apply_markdown',
    sourceAuthority,
    targetPath: sourceAuthority.filePath!,
    artifactDigest: artifact.digest,
    artifactPayload: artifact.payload,
  });

  return buildRunDraft({
    sourceAuthority,
    displayPrompt: `Apply artifact to ${sourceAuthority.filePath}`,
    promptLines: [
      'Apply this artifact preview to the current file.',
      '',
      'Requirements:',
      '- Treat the artifact as a derived preview, not the source of truth.',
      '- Read the target file again before mutating it.',
      '- Use write_file or apply_patch with approval and version checks.',
      `Target file: ${sourceAuthority.filePath}`,
      ...buildSourceAuthorityPromptLines(sourceAuthority, intentSnapshotId),
      '',
      ...buildArtifactPromptBody(artifact),
    ],
  });
}

export function buildArtifactExportRunDraftFromAuthority(args: {
  artifact: ThreadArtifactVersion;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
  targetPath: string;
}): RunRequest | null {
  const artifact = args.artifact;
  const sourceAuthority = args.sourceAuthority;
  const targetPath = args.targetPath.trim();
  if (artifact.renderer !== 'markdown' || !sourceAuthority || !targetPath) {
    return null;
  }
  const intentSnapshotId = createArtifactDurabilityIntentSnapshotId({
    action: 'export_markdown',
    sourceAuthority,
    targetPath,
    artifactDigest: artifact.digest,
    artifactPayload: artifact.payload,
  });

  return buildRunDraft({
    sourceAuthority,
    displayPrompt: `Export artifact to ${targetPath}`,
    promptLines: [
      'Export the current artifact preview into a computer file.',
      'Treat the artifact as a derived preview, not the source of truth.',
      'Use the normal file mutation path with approval and versionToken checks.',
      `Target export path: ${targetPath}`,
      ...buildSourceAuthorityPromptLines(sourceAuthority, intentSnapshotId),
      '',
      ...buildArtifactPromptBody(artifact),
    ],
  });
}

export function buildGeneratedTextExportRunDraftFromAuthority(args: {
  snapshot: GeneratedTextExportSnapshot | null;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
  targetPath: string;
}): RunRequest | null {
  const snapshot = sanitizeGeneratedTextExportSnapshot(args.snapshot);
  const sourceAuthority = args.sourceAuthority;
  const targetPath = args.targetPath.trim();
  if (!snapshot || !sourceAuthority || !targetPath) {
    return null;
  }
  const intentSnapshotId = createArtifactDurabilityIntentSnapshotId({
    action: 'export_generated_text',
    sourceAuthority,
    targetPath,
    snapshot,
  });

  return buildRunDraft({
    sourceAuthority,
    displayPrompt: `Export generated asset to ${targetPath}`,
    promptLines: [
      'Export the current JS runtime generated text snapshot into a computer file.',
      'Treat the snapshot as a derived export, not the source of truth.',
      'Use the normal file mutation path with approval and versionToken checks.',
      `Target export path: ${targetPath}`,
      ...buildSourceAuthorityPromptLines(sourceAuthority, intentSnapshotId),
      `Snapshot mime type: ${snapshot.mimeType}`,
      snapshot.fileNameHint
        ? `Snapshot file name hint: ${snapshot.fileNameHint}`
        : '',
      '',
      ...buildGeneratedTextPromptBody(snapshot),
    ],
  });
}

export function canBuildArtifactExportRunFromAuthority(args: {
  artifact: ThreadArtifactVersion;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
}): boolean {
  return args.artifact.renderer === 'markdown' && args.sourceAuthority !== null;
}

export function canBuildGeneratedTextExportRunFromAuthority(args: {
  snapshot: GeneratedTextExportSnapshot | null;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
}): boolean {
  return (
    sanitizeGeneratedTextExportSnapshot(args.snapshot) !== null &&
    args.sourceAuthority !== null
  );
}

export function canBuildGeneratedBinaryExportFromAuthority(args: {
  snapshot: GeneratedBinaryExportSnapshot | null;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
}): boolean {
  return (
    sanitizeGeneratedBinaryExportSnapshot(args.snapshot) !== null &&
    args.sourceAuthority !== null
  );
}

export function deriveGeneratedTextExportTargetPathHint(args: {
  snapshot: GeneratedTextExportSnapshot | null;
}): string {
  const snapshot = sanitizeGeneratedTextExportSnapshot(args.snapshot);
  if (!snapshot) {
    return 'exports/artifact-preview.txt';
  }
  const fileNameHint = sanitizeGeneratedTextExportFileNameHint(
    snapshot.fileNameHint,
  );
  if (fileNameHint) {
    return `exports/${fileNameHint}`;
  }
  return `exports/artifact-preview${readGeneratedTextExportExtension(snapshot.mimeType)}`;
}

export function deriveGeneratedBinaryExportTargetPathHint(args: {
  snapshot: GeneratedBinaryExportSnapshot | null;
}): string {
  const snapshot = sanitizeGeneratedBinaryExportSnapshot(args.snapshot);
  if (!snapshot) {
    return 'exports/artifact-preview.bin';
  }
  const fileNameHint = sanitizeGeneratedTextExportFileNameHint(
    snapshot.fileNameHint,
  );
  if (fileNameHint) {
    return `exports/${fileNameHint}`;
  }
  return `exports/artifact-preview${readGeneratedBinaryExportExtension(snapshot.blob.type)}`;
}

// 아티팩트 다시 만들기(♻) — 라우팅은 모델이 스스로 판단한다: 망가졌으면
// 수리(국소 최소 수정/구조적 재작성), 멀쩡하면 같은 요청의 새로운 변주.
// "고장 수리"로만 정의하면 멀쩡한 아티팩트에서 거의 같은 결과가 반복된다.
// 결과는 같은 아티팩트의 새 버전 커밋으로 이어진다.
export function buildArtifactRewriteRunDraft(args: {
  artifact: Pick<
    ThreadArtifactVersion,
    'artifactId' | 'version' | 'renderer' | 'payload' | 'title'
  >;
  threadId: ThreadId;
}): RunRequest {
  const { artifact, threadId } = args;
  const title =
    artifact.title !== null && artifact.title.trim() !== ''
      ? artifact.title
      : '아티팩트';
  return {
    threadId,
    displayPrompt: `아티팩트 다시 만들기 — ${title}`,
    // 채팅에 질문 말풍선을 만들지 않는다 — 결과는 아티팩트 표면에서
    // 새 버전 스트리밍으로 보인다 (감사 기록은 metadata.silent로 남음)
    silentPrompt: true,
    prompt: buildPromptText([
      'The user pressed the redo (♻) button on the artifact below and expects a visibly new result.',
      'First check whether it is actually broken, then route yourself:',
      '- If the defect is local, apply a minimal targeted fix and keep everything that already works.',
      '- If it is structurally broken, rebuild it from scratch with the same intent.',
      '- If nothing is broken, treat this as "try again": create a fresh take on the same request — meaningfully different composition, styling, or details. Never return a near-identical copy.',
      'Commit the result as a new version of the same artifact: put',
      `"artifactId":"${artifact.artifactId}" and "baseVersion":${artifact.version}`,
      'into the GEULBAT_ARTIFACT envelope header exactly as given.',
      `Artifact id: ${artifact.artifactId}`,
      `Current version: ${artifact.version}`,
      `Renderer: ${artifact.renderer}`,
      '<artifact_payload>',
      artifact.payload,
      '</artifact_payload>',
    ]),
  };
}

// 티어 B 강등 (back-channel 설계 §7) — read-only 게이트가 거부한 프레임 발
// 도구 호출을 "아티팩트가 X를 요청함" 프롬프트로 번역한다. 실행은 agent
// loop + ApprovalRequired + 사용자 승인이 중재하고(불변식 #3), 턴은
// promptOrigin으로 아티팩트 발 귀속 렌더된다(가시성 불변식 — silent 금지).
export function buildArtifactFrameToolFallbackRunDraft(args: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  threadId: ThreadId;
}): RunRequest {
  const { toolName, toolArgs, threadId } = args;
  return {
    threadId,
    promptOrigin: 'artifact_frame',
    displayPrompt: `아티팩트가 "${toolName}" 실행을 요청함`,
    prompt: buildPromptText([
      'An artifact frame requested a tool call that is outside the direct',
      'read-only surface, so it was degraded to this prompt.',
      'Decide whether the request is reasonable in the current context.',
      'If it is, perform it through your normal tools — side effects go',
      'through the standard approval flow. If it is not, explain why.',
      `Requested tool: ${toolName}`,
      'Requested arguments (untrusted, from the artifact frame):',
      '<artifact_tool_request_args>',
      JSON.stringify(toolArgs, null, 2),
      '</artifact_tool_request_args>',
    ]),
  };
}

function buildRunDraft(args: {
  sourceAuthority: ResolvedArtifactSourceAuthority;
  displayPrompt: string;
  promptLines: string[];
}): RunRequest {
  const { sourceAuthority, displayPrompt, promptLines } = args;
  const sourceFilePath = sourceAuthority.filePath;
  return {
    threadId: sourceAuthority.threadId,
    displayPrompt,
    workingDirectory: sourceAuthority.workingDirectory,
    allowedPublicToolNames: [...FILE_MUTATION_ALLOWED_TOOLS],
    prompt: buildPromptText(promptLines),
    ...(sourceFilePath !== null
      ? {
          currentFile: sourceFilePath,
        }
      : {}),
  };
}

function buildSourceAuthorityPromptLines(
  sourceAuthority: ResolvedArtifactSourceAuthority,
  intentSnapshotId: string,
): string[] {
  return [
    `Artifact session authority key: ${createArtifactDurabilitySourceAuthorityKey(sourceAuthority)}`,
    `Explicit durability intent id: ${intentSnapshotId}`,
    sourceAuthority.filePath
      ? `Source file context: ${sourceAuthority.filePath}`
      : '',
    `Source artifact runId: ${sourceAuthority.runId}`,
    `Source artifact message timestamp: ${sourceAuthority.messageTimestamp}`,
  ];
}

function buildArtifactPromptBody(artifact: ThreadArtifactVersion): string[] {
  return [
    '<artifact_preview>',
    `renderer: ${artifact.renderer}`,
    artifact.digest ? `digest: ${artifact.digest}` : 'digest: (none)',
    '<artifact_payload>',
    artifact.payload,
    '</artifact_payload>',
    '</artifact_preview>',
  ];
}

function buildGeneratedTextPromptBody(
  snapshot: GeneratedTextExportSnapshot,
): string[] {
  return [
    `<generated_text_snapshot mimeType="${snapshot.mimeType}">`,
    snapshot.content,
    '</generated_text_snapshot>',
  ];
}

function buildPromptText(lines: string[]): string {
  return lines.filter(Boolean).join('\n');
}

function readGeneratedTextExportExtension(
  mimeType: GeneratedTextExportSnapshot['mimeType'],
): string {
  switch (mimeType) {
    case 'text/html':
      return '.html';
    case 'text/css':
      return '.css';
    case 'application/json':
      return '.json';
    case 'image/svg+xml':
      return '.svg';
    case 'text/markdown':
      return '.md';
    case 'text/plain':
      return '.txt';
  }
  // default를 두지 않는다 — 닫힌 유니온이므로 항목이 늘면 여기서 컴파일이
  // 깨져야 한다. 폴백이 있으면 새 형식이 조용히 .txt로 나간다.
}

function readGeneratedBinaryExportExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'audio/wav':
      return '.wav';
    case 'audio/mpeg':
      return '.mp3';
    default:
      return '.bin';
  }
}
