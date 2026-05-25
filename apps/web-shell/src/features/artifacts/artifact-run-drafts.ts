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
  type ArtifactParseResult,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
} from './artifact-types.js';

const FILE_MUTATION_ALLOWED_TOOLS = [
  'read_file',
  'write_file',
  'patch_file',
] as const;

type ResolvedArtifactSourceAuthority = ArtifactDurabilitySourceAuthority;

export function buildArtifactApplyRunDraftFromAuthority(args: {
  parsed: ArtifactParseResult;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
}): RunRequest | null {
  const parsed = args.parsed;
  const sourceAuthority = args.sourceAuthority;
  if (
    parsed.kind !== 'artifact' ||
    parsed.state !== 'completed' ||
    parsed.renderer !== 'markdown' ||
    !sourceAuthority ||
    sourceAuthority.filePath === null
  ) {
    return null;
  }
  const intentSnapshotId = createArtifactDurabilityIntentSnapshotId({
    action: 'apply_markdown',
    sourceAuthority,
    targetPath: sourceAuthority.filePath!,
    artifactDigest: parsed.digest,
    artifactPayload: parsed.payload,
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
      '- Use write_file or patch_file with approval and versionToken checks.',
      `Target file: ${sourceAuthority.filePath}`,
      ...buildSourceAuthorityPromptLines(sourceAuthority, intentSnapshotId),
      '',
      ...buildArtifactPromptBody(parsed),
    ],
  });
}

export function buildArtifactExportRunDraftFromAuthority(args: {
  parsed: ArtifactParseResult;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
  targetPath: string;
}): RunRequest | null {
  const parsed = args.parsed;
  const sourceAuthority = args.sourceAuthority;
  const targetPath = args.targetPath.trim();
  if (
    parsed.kind !== 'artifact' ||
    parsed.state !== 'completed' ||
    parsed.renderer !== 'markdown' ||
    !sourceAuthority ||
    !targetPath
  ) {
    return null;
  }
  const intentSnapshotId = createArtifactDurabilityIntentSnapshotId({
    action: 'export_markdown',
    sourceAuthority,
    targetPath,
    artifactDigest: parsed.digest,
    artifactPayload: parsed.payload,
  });

  return buildRunDraft({
    sourceAuthority,
    displayPrompt: `Export artifact to ${targetPath}`,
    promptLines: [
      'Export the current artifact preview into a workspace file.',
      'Treat the artifact as a derived preview, not the source of truth.',
      'Use the normal file mutation path with approval and versionToken checks.',
      `Target export path: ${targetPath}`,
      ...buildSourceAuthorityPromptLines(sourceAuthority, intentSnapshotId),
      '',
      ...buildArtifactPromptBody(parsed),
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
      'Export the current JS runtime generated text snapshot into a workspace file.',
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
  parsed: ArtifactParseResult;
  sourceAuthority: ResolvedArtifactSourceAuthority | null;
}): boolean {
  return (
    args.parsed.kind === 'artifact' &&
    args.parsed.state === 'completed' &&
    args.parsed.renderer === 'markdown' &&
    args.sourceAuthority !== null
  );
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

function buildRunDraft(args: {
  sourceAuthority: ResolvedArtifactSourceAuthority;
  displayPrompt: string;
  promptLines: string[];
}): RunRequest {
  const { sourceAuthority, displayPrompt, promptLines } = args;
  return {
    projectId: sourceAuthority.projectId,
    threadId: sourceAuthority.threadId,
    displayPrompt,
    allowedToolsHint: [...FILE_MUTATION_ALLOWED_TOOLS],
    prompt: buildPromptText(promptLines),
    ...(sourceAuthority.filePath !== null
      ? { currentFile: sourceAuthority.filePath }
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

function buildArtifactPromptBody(parsed: ArtifactParseResult): string[] {
  if (parsed.kind !== 'artifact') {
    return [parsed.raw];
  }

  return [
    '<artifact_preview>',
    `renderer: ${parsed.renderer ?? 'unknown'}`,
    parsed.digest ? `digest: ${parsed.digest}` : 'digest: (none)',
    '<artifact_payload>',
    parsed.payload,
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
    default:
      return '.txt';
  }
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
