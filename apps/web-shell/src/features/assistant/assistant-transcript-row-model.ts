import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import {
  readCommittedMessageArtifact,
  type ArtifactsByRefMap,
} from '../artifacts/artifact-transcript-lookup.js';
import { splitMessageContentSegments } from './assistant-message-content.js';
import { canRenderInlineImageArtifact } from './artifact-pane/inline-image-artifact.js';
import { isCommandToolName } from './tool-timeline.js';
import {
  parseToolResultView,
  type PtcToolActivityStatus,
} from './tool-result-view.js';
import {
  ASK_USER_TOOL_NAME,
  readAskUserCardViewFromToolArgs,
} from './ask-user/ask-user-card-view.js';
import { VISUALIZE_TOOL_NAME } from './visualize/visualize-widget-view.js';

// 대화 행 모델 — 가상 리스트(assistant-transcript-virtual-list.tsx)가 그릴
// 행을 settled 메시지/라이브 엔트리에서 빌드한다. 렌더와 무관한 순수 계층:
// ask_user 카드 억제, 도구 그룹 병합, 행 높이 추정이 전부 여기 산다.

type ToolActivityEntry = Extract<RunTranscriptEntry, { kind: 'tool_activity' }>;

export type TranscriptVirtualRow =
  | {
      kind: 'message';
      key: string;
      message: ThreadMessage;
      messageIndex: number;
    }
  | {
      kind: 'settled_tool_group';
      key: string;
      messages: ThreadMessage[];
      messageKeys: string[];
      tools: string[];
      activityCount: number;
      // 접힌 헤더용 호출 수 — 그룹 빌드 시 경량 스캔으로 세어 둔다
      commandCallCount: number;
      toolCallCount: number;
      failed: boolean;
      ptcStatus?: PtcToolActivityStatus;
    }
  | {
      kind: 'entry';
      key: string;
      entry: RunTranscriptEntry;
      // approval_request 카드용 — 같은 callId 도구의 실행 상태를 연결해
      // 카드에 상태 점(실행중/완료/실패)을 그린다.
      approvalStatus?: ToolActivityEntry['state'];
    }
  | {
      kind: 'subagent_group';
      key: string;
      entries: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>[];
    }
  | {
      kind: 'live_tool_group';
      key: string;
      entries: ToolActivityEntry[];
      tools: string[];
      activityCount: number;
      failed: boolean;
      running: boolean;
      ptcStatus?: PtcToolActivityStatus;
    };

interface TranscriptVirtualRowCollection {
  rows: TranscriptVirtualRow[];
  visualizeRowIndexes: number[];
}

interface ParsedToolMessage {
  tool: string | null;
  callId: string | null;
  failed: boolean;
}

interface SettledAskUserMessageAnalysis {
  askUserCallIds: ReadonlySet<string>;
  askUserResultFailureByCallId: ReadonlyMap<string, boolean>;
  suppressedLegacyAskUserEchoIndexes: ReadonlySet<number>;
  hasLaterUserMessage: readonly boolean[];
}

const TRANSCRIPT_ROW_ESTIMATE = 120;
const TRANSCRIPT_TOOL_GROUP_ROW_ESTIMATE = 44;
const TRANSCRIPT_REASONING_COLLAPSED_ROW_ESTIMATE = 44;
// The transcript is roughly 400 CSS pixels wide. These geometry estimates
// intentionally favor slight overestimation so end anchoring does not mount
// expensive Markdown rows only to discard them after DOM measurement.
const TRANSCRIPT_MESSAGE_CHARS_PER_LINE_ESTIMATE = 28;
const TRANSCRIPT_MESSAGE_LINE_HEIGHT_ESTIMATE = 20;
const TRANSCRIPT_MESSAGE_CHROME_ESTIMATE = 80;
const TRANSCRIPT_CODE_BLOCK_CHROME_LINE_ESTIMATE = 2;
const TRANSCRIPT_INLINE_IMAGE_HEIGHT_ESTIMATE = 480;
const transcriptTextRowEstimateByMessage = new WeakMap<ThreadMessage, number>();

function estimateMessageTextVisualLines(content: string): number {
  return splitMessageContentSegments(content).reduce((total, segment) => {
    if (segment.kind === 'code') {
      return (
        total +
        segment.code.split('\n').length +
        TRANSCRIPT_CODE_BLOCK_CHROME_LINE_ESTIMATE
      );
    }
    return (
      total +
      segment.text.split('\n').reduce((lineTotal, line) => {
        const trimmedLine = line.trim();
        const estimatedLines =
          trimmedLine.startsWith('|') && trimmedLine.endsWith('|')
            ? 1
            : Math.max(
                1,
                Math.ceil(
                  line.length / TRANSCRIPT_MESSAGE_CHARS_PER_LINE_ESTIMATE,
                ),
              );
        return lineTotal + estimatedLines;
      }, 0)
    );
  }, 0);
}

export function estimateTranscriptMessageRowSize(
  message: ThreadMessage,
  artifactsByRef: ArtifactsByRefMap,
): number {
  if (
    message.role === 'assistant' &&
    message.metadata?.phase === 'commentary'
  ) {
    return TRANSCRIPT_REASONING_COLLAPSED_ROW_ESTIMATE;
  }

  let textEstimate = transcriptTextRowEstimateByMessage.get(message);
  if (textEstimate === undefined) {
    textEstimate = Math.max(
      TRANSCRIPT_ROW_ESTIMATE,
      TRANSCRIPT_MESSAGE_CHROME_ESTIMATE +
        estimateMessageTextVisualLines(message.content) *
          TRANSCRIPT_MESSAGE_LINE_HEIGHT_ESTIMATE,
    );
    transcriptTextRowEstimateByMessage.set(message, textEstimate);
  }

  if (message.role !== 'assistant') {
    return textEstimate;
  }
  const artifact = readCommittedMessageArtifact(message, artifactsByRef);
  return artifact !== null && canRenderInlineImageArtifact(artifact)
    ? textEstimate + TRANSCRIPT_INLINE_IMAGE_HEIGHT_ESTIMATE
    : textEstimate;
}

function analyzeSettledAskUserMessages(
  messages: readonly ThreadMessage[],
): SettledAskUserMessageAnalysis {
  const askUserCallIds = new Set<string>();
  const askUserResultFailureByCallId = new Map<string, boolean>();
  const askUserResultIndexByCallId = new Map<string, number>();
  const suppressedLegacyAskUserEchoIndexes = new Set<number>();
  const hasLaterUserMessage = new Array<boolean>(messages.length).fill(false);
  let sawUserMessage = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    hasLaterUserMessage[index] = sawUserMessage;
    if (messages[index]?.role === 'user') {
      sawUserMessage = true;
    }
  }

  for (const message of messages) {
    if (message.role !== 'tool_call') {
      continue;
    }
    const parsed = parseToolMessage(message);
    if (parsed.tool === ASK_USER_TOOL_NAME && parsed.callId !== null) {
      askUserCallIds.add(parsed.callId);
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool_result') {
      continue;
    }
    const parsed = parseToolMessage(message);
    if (parsed.callId !== null && askUserCallIds.has(parsed.callId)) {
      askUserResultFailureByCallId.set(parsed.callId, parsed.failed);
      askUserResultIndexByCallId.set(parsed.callId, index);
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'tool_call') {
      continue;
    }
    const parsed = parseToolMessage(message);
    if (parsed.tool !== ASK_USER_TOOL_NAME || parsed.callId === null) {
      continue;
    }
    const resultIndex = askUserResultIndexByCallId.get(parsed.callId) ?? -1;
    const echoIndex = resultIndex + 1;
    const echo = resultIndex > index ? messages[echoIndex] : undefined;
    const view = readAskUserCardViewFromToolArgs(
      readCanonicalJsonRecordField(message.content, 'args') ?? {},
    );
    if (
      echo?.role === 'assistant' &&
      view !== null &&
      echo.content.includes(view.question) &&
      view.options.every((option) => echo.content.includes(option.label))
    ) {
      suppressedLegacyAskUserEchoIndexes.add(echoIndex);
    }
  }

  return {
    askUserCallIds,
    askUserResultFailureByCallId,
    suppressedLegacyAskUserEchoIndexes,
    hasLaterUserMessage,
  };
}

export function buildSettledTranscriptRows(args: {
  messages: ThreadMessage[];
  messageKeys: string[];
  answeredAskUserRequestKeys: ReadonlySet<string>;
  // 과거 런의 서브에이전트 종료 카드 — 귀속 대상 메시지(entryId) 바로 위에
  // entry 행으로 끼워 넣는다. 라이브 영역에 눌어붙지 않게 하는 장치.
  anchoredSubagentEntries?: ReadonlyMap<
    string,
    Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>[]
  >;
}): TranscriptVirtualRowCollection {
  const rows: TranscriptVirtualRow[] = [];
  const visualizeRowIndexes: number[] = [];
  const {
    askUserCallIds,
    askUserResultFailureByCallId,
    suppressedLegacyAskUserEchoIndexes,
    hasLaterUserMessage,
  } = analyzeSettledAskUserMessages(args.messages);
  for (let index = 0; index < args.messages.length;) {
    const message = args.messages[index]!;
    if (suppressedLegacyAskUserEchoIndexes.has(index)) {
      index += 1;
      continue;
    }
    const parsedMessage = isToolMessage(message)
      ? parseToolMessage(message)
      : null;
    if (
      message.role === 'tool_call' &&
      parsedMessage?.tool === ASK_USER_TOOL_NAME
    ) {
      const requestKey = parsedMessage.callId ?? message.entryId;
      const answered = hasLaterUserMessage[index] === true;
      const failed =
        parsedMessage.callId !== null &&
        askUserResultFailureByCallId.get(parsedMessage.callId) === true;
      if (
        answered ||
        failed ||
        args.answeredAskUserRequestKeys.has(requestKey)
      ) {
        index += 1;
        continue;
      }
    }
    if (
      message.role === 'tool_result' &&
      parsedMessage !== null &&
      parsedMessage.callId !== null &&
      askUserCallIds.has(parsedMessage.callId) &&
      askUserResultFailureByCallId.get(parsedMessage.callId) === false
    ) {
      index += 1;
      continue;
    }
    // visualize 호출 메시지는 접힌 도구 그룹에 넣지 않고 위젯 행으로 노출
    if (!isToolMessage(message) || isInteractiveToolCallMessage(message)) {
      if (
        message.role === 'tool_call' &&
        readCanonicalJsonStringField(message.content, 'tool') ===
          VISUALIZE_TOOL_NAME
      ) {
        visualizeRowIndexes.push(rows.length);
      }
      const anchoredEntries = args.anchoredSubagentEntries?.get(
        message.entryId,
      );
      if (anchoredEntries !== undefined) {
        if (anchoredEntries.length === 1) {
          const anchoredEntry = anchoredEntries[0]!;
          rows.push({
            kind: 'entry',
            key: `subagent-history:${anchoredEntry.childRunId}`,
            entry: anchoredEntry,
          });
        } else if (anchoredEntries.length > 1) {
          rows.push({
            kind: 'subagent_group',
            key: `subagent-history-group:${message.entryId}`,
            entries: [...anchoredEntries],
          });
        }
      }
      rows.push({
        kind: 'message',
        key: args.messageKeys[index] ?? message.entryId,
        message,
        messageIndex: index,
      });
      index += 1;
      continue;
    }

    const start = index;
    while (index < args.messages.length) {
      const candidate = args.messages[index]!;
      const candidateTool = isToolMessage(candidate)
        ? parseToolMessage(candidate)
        : null;
      const suppressesAskUserResult =
        candidate.role === 'tool_result' &&
        candidateTool?.callId !== null &&
        candidateTool?.callId !== undefined &&
        askUserCallIds.has(candidateTool.callId) &&
        askUserResultFailureByCallId.get(candidateTool.callId) === false;
      if (
        !isToolMessage(candidate) ||
        isInteractiveToolCallMessage(candidate) ||
        suppressesAskUserResult
      ) {
        break;
      }
      index += 1;
    }
    const messages = args.messages.slice(start, index);
    const parsed = messages.map(parseToolMessage);
    const callIds = new Set(
      parsed.flatMap((item) => (item.callId === null ? [] : [item.callId])),
    );
    let commandCallCount = 0;
    let toolCallCount = 0;
    parsed.forEach((item, parsedIndex) => {
      if (messages[parsedIndex]!.role !== 'tool_call') {
        return;
      }
      if (isCommandToolName(item.tool)) {
        commandCallCount += 1;
      } else {
        toolCallCount += 1;
      }
    });
    const firstKey = args.messageKeys[start] ?? messages[0]!.entryId;
    const lastKey = args.messageKeys[index - 1] ?? messages.at(-1)!.entryId;
    const ptcStatus = readLatestSettledPtcStatus(messages);
    rows.push({
      kind: 'settled_tool_group',
      key: `settled-tool-group:${firstKey}:${lastKey}`,
      messages,
      messageKeys: args.messageKeys.slice(start, index),
      tools: uniqueStrings(
        parsed.flatMap((item) => (item.tool === null ? [] : [item.tool])),
      ),
      activityCount: callIds.size > 0 ? callIds.size : messages.length,
      commandCallCount,
      toolCallCount,
      failed: parsed.some((item) => item.failed),
      ...(ptcStatus === undefined ? {} : { ptcStatus }),
    });
  }

  return { rows, visualizeRowIndexes };
}

export function buildLiveTranscriptRows(args: {
  transcriptEntries: RunTranscriptEntry[];
  transcriptEntryKeys: string[];
  answeredAskUserRequestKeys: ReadonlySet<string>;
}): TranscriptVirtualRowCollection {
  const rows: TranscriptVirtualRow[] = [];
  const visualizeRowIndexes: number[] = [];
  const askUserResultStateByCallId = new Map<
    string,
    ToolActivityEntry['state']
  >();
  // 모든 도구 활동의 최신 상태를 callId로 색인 — approval_request 카드에
  // 실행 상태를 연결하는 데 쓴다. 뒤에 오는 completed/failed가 running을 덮는다.
  const toolStateByCallId = new Map<string, ToolActivityEntry['state']>();
  const hasLaterUserEntry = new Array<boolean>(
    args.transcriptEntries.length,
  ).fill(false);
  let sawUserEntry = false;

  for (let index = args.transcriptEntries.length - 1; index >= 0; index -= 1) {
    hasLaterUserEntry[index] = sawUserEntry;
    if (args.transcriptEntries[index]?.kind === 'user_text') {
      sawUserEntry = true;
    }
  }

  for (const entry of args.transcriptEntries) {
    if (entry.kind === 'tool_activity' && entry.callId !== undefined) {
      toolStateByCallId.set(entry.callId, entry.state);
      if (entry.tool === ASK_USER_TOOL_NAME && entry.args === undefined) {
        askUserResultStateByCallId.set(entry.callId, entry.state);
      }
    }
  }

  for (let index = 0; index < args.transcriptEntries.length;) {
    const entry = args.transcriptEntries[index]!;
    if (
      entry.kind === 'subagent_activity' &&
      (entry.state === 'spawned' || entry.state === 'approval_required')
    ) {
      index += 1;
      continue;
    }
    if (
      entry.kind === 'subagent_activity' &&
      entry.state !== 'spawned' &&
      entry.state !== 'approval_required'
    ) {
      const start = index;
      const entries: Extract<
        RunTranscriptEntry,
        { kind: 'subagent_activity' }
      >[] = [];
      while (index < args.transcriptEntries.length) {
        const candidate = args.transcriptEntries[index];
        if (
          candidate?.kind !== 'subagent_activity' ||
          candidate.state === 'spawned' ||
          candidate.state === 'approval_required'
        ) {
          break;
        }
        entries.push(candidate);
        index += 1;
      }
      const firstKey =
        args.transcriptEntryKeys[start] ??
        `subagent:${entries[0]?.childRunId ?? start}`;
      if (entries.length === 1) {
        rows.push({
          kind: 'entry',
          key: firstKey,
          entry: entries[0]!,
        });
      } else {
        rows.push({
          kind: 'subagent_group',
          key: `subagent-group:${firstKey}`,
          entries,
        });
      }
      continue;
    }
    const isAskUserCard = isAskUserCardEntry(entry);
    if (isAskUserCard) {
      const requestKey =
        entry.callId ??
        args.transcriptEntryKeys[index] ??
        `${entry.tool}:${index}`;
      const resultState =
        entry.callId === undefined
          ? undefined
          : askUserResultStateByCallId.get(entry.callId);
      const answered = hasLaterUserEntry[index] === true;
      if (
        resultState === 'failed' ||
        answered ||
        args.answeredAskUserRequestKeys.has(requestKey)
      ) {
        index += 1;
        continue;
      }
    }
    if (
      entry.kind === 'tool_activity' &&
      entry.tool === ASK_USER_TOOL_NAME &&
      entry.args === undefined &&
      entry.state === 'completed'
    ) {
      index += 1;
      continue;
    }
    // visualize 위젯 엔트리도 접힌 도구 그룹 밖의 독립 행으로 노출
    const isVisualizeEntry = isVisualizeWidgetEntry(entry);
    if (entry.kind !== 'tool_activity' || isVisualizeEntry || isAskUserCard) {
      if (isVisualizeEntry) {
        visualizeRowIndexes.push(rows.length);
      }
      const approvalStatus =
        entry.kind === 'approval_request' &&
        entry.pendingApproval.callId !== undefined
          ? toolStateByCallId.get(entry.pendingApproval.callId)
          : undefined;
      rows.push({
        kind: 'entry',
        key: args.transcriptEntryKeys[index] ?? `${entry.kind}:${index}`,
        entry,
        ...(approvalStatus === undefined ? {} : { approvalStatus }),
      });
      index += 1;
      continue;
    }

    const start = index;
    const entries: ToolActivityEntry[] = [];
    while (index < args.transcriptEntries.length) {
      const candidate = args.transcriptEntries[index]!;
      if (
        candidate.kind !== 'tool_activity' ||
        isVisualizeWidgetEntry(candidate) ||
        isAskUserCardEntry(candidate) ||
        isCompletedAskUserResultEntry(candidate)
      ) {
        break;
      }
      entries.push(candidate);
      index += 1;
    }
    const firstKey =
      args.transcriptEntryKeys[start] ?? `${entries[0]!.tool}:${start}`;
    const lastKey =
      args.transcriptEntryKeys[index - 1] ??
      `${entries.at(-1)!.tool}:${index - 1}`;
    const ptcStatus = readLatestPtcStatus(entries);
    rows.push({
      kind: 'live_tool_group',
      key: `live-tool-group:${firstKey}:${lastKey}`,
      entries,
      tools: uniqueStrings(entries.map((item) => item.tool)),
      activityCount: entries.length,
      failed: entries.some((item) => item.state === 'failed'),
      running: entries.some((item) => item.state === 'running'),
      ...(ptcStatus === undefined ? {} : { ptcStatus }),
    });
  }

  return { rows, visualizeRowIndexes };
}

function isToolMessage(message: ThreadMessage): boolean {
  return message.role === 'tool_call' || message.role === 'tool_result';
}

// 접힌 도구 그룹에 넣지 않고 독립 행으로 그리는 상호작용형 호출
// (visualize 위젯, ask_user 선택지 카드)
function isInteractiveToolCallMessage(message: ThreadMessage): boolean {
  if (message.role !== 'tool_call') {
    return false;
  }
  const tool = readCanonicalJsonStringField(message.content, 'tool');
  return tool === VISUALIZE_TOOL_NAME || tool === ASK_USER_TOOL_NAME;
}

function isVisualizeWidgetEntry(entry: RunTranscriptEntry): boolean {
  return (
    entry.kind === 'tool_activity' &&
    entry.tool === VISUALIZE_TOOL_NAME &&
    entry.args !== undefined
  );
}

function isAskUserCardEntry(
  entry: RunTranscriptEntry,
): entry is ToolActivityEntry & { args: Record<string, unknown> } {
  return (
    entry.kind === 'tool_activity' &&
    entry.tool === ASK_USER_TOOL_NAME &&
    entry.args !== undefined
  );
}

function isCompletedAskUserResultEntry(entry: RunTranscriptEntry): boolean {
  return (
    entry.kind === 'tool_activity' &&
    entry.tool === ASK_USER_TOOL_NAME &&
    entry.args === undefined &&
    entry.state === 'completed'
  );
}

export function isVisualizeWidgetRow(
  row: TranscriptVirtualRow | undefined,
): boolean {
  if (row?.kind === 'message') {
    return (
      row.message.role === 'tool_call' &&
      readCanonicalJsonStringField(row.message.content, 'tool') ===
        VISUALIZE_TOOL_NAME
    );
  }
  return row?.kind === 'entry' && isVisualizeWidgetEntry(row.entry);
}

function parseToolMessage(message: ThreadMessage): ParsedToolMessage {
  return {
    tool: readCanonicalJsonStringField(message.content, 'tool'),
    callId: readCanonicalJsonStringField(message.content, 'callId'),
    failed: message.content.includes('"ok":false'),
  };
}

function readLatestSettledPtcStatus(
  messages: readonly ThreadMessage[],
): PtcToolActivityStatus | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool_result') {
      continue;
    }
    const tool = readCanonicalJsonStringField(message.content, 'tool');
    if (tool !== 'exec' && tool !== 'wait') {
      continue;
    }
    return parseToolResultView(message.content)?.ptcStatus;
  }
  return undefined;
}

function readLatestPtcStatus(
  items: readonly {
    tool?: string | null;
    ptcStatus?: PtcToolActivityStatus;
  }[],
): PtcToolActivityStatus | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const status = item?.ptcStatus;
    if (status !== undefined) {
      return status;
    }
    if (item?.tool === 'exec' || item?.tool === 'wait') {
      return undefined;
    }
  }
  return undefined;
}

function readCanonicalJsonStringField(
  content: string,
  field: string,
): string | null {
  const marker = `"${field}":"`;
  const valueStart = content.indexOf(marker);
  if (valueStart < 0) {
    return null;
  }
  const start = valueStart + marker.length;
  const end = content.indexOf('"', start);
  if (end < 0) {
    return null;
  }
  const value = content.slice(start, end);
  return value.includes('\\') ? null : value;
}

function readCanonicalJsonRecordField(
  content: string,
  field: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function findLastRoleIndex(
  messages: readonly ThreadMessage[],
  role: ThreadMessage['role'],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

export function estimateTranscriptRowSize(
  row: TranscriptVirtualRow | undefined,
  artifactsByRef: ArtifactsByRefMap,
): number {
  if (row?.kind === 'settled_tool_group' || row?.kind === 'live_tool_group') {
    return TRANSCRIPT_TOOL_GROUP_ROW_ESTIMATE;
  }
  if (row?.kind === 'message') {
    return estimateTranscriptMessageRowSize(row.message, artifactsByRef);
  }
  return TRANSCRIPT_ROW_ESTIMATE;
}
