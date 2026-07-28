import type { GoalSnapshot } from '@geulbat/protocol/goal';
import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';
import type {
  RunModelId,
  RunReasoningSelection,
} from '@geulbat/protocol/run-contract';

import { formatContextUsageSummary } from './context-usage-ring.js';
import { formatRunModelLabel, REASONING_EFFORT_LABELS } from './model-copy.js';

export type ComposerSlashCommandId = 'goal' | 'skills' | 'mcp' | 'status';

export interface ComposerSlashCommandSuggestion {
  id: ComposerSlashCommandId;
  command: string;
  label: string;
}

const COMMANDS: ReadonlyArray<
  ComposerSlashCommandSuggestion & { keywords: readonly string[] }
> = [
  {
    id: 'goal',
    command: '/goal',
    label: '목표',
    keywords: ['goal', '목표'],
  },
  {
    id: 'skills',
    command: '/skills',
    label: '스킬',
    keywords: ['skill', 'skills', '스킬'],
  },
  {
    id: 'mcp',
    command: '/mcp',
    label: 'MCP',
    keywords: ['mcp', '서버', '도구'],
  },
  {
    id: 'status',
    command: '/status',
    label: '상태',
    keywords: ['status', '상태', '컨텍스트'],
  },
];

const GOAL_STATE_LABELS: Record<GoalSnapshot['state'], string> = {
  working: '진행 중',
  continuing: '이어가는 중',
  verifying: '검증 중',
  completed: '완료',
  paused: '일시 중지',
  verification_unavailable: '검증 대기',
};

export function getComposerSlashCommandSuggestions(
  query: string,
): readonly ComposerSlashCommandSuggestion[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR');
  if (normalizedQuery === '') {
    return COMMANDS;
  }
  return COMMANDS.filter(
    (candidate) =>
      candidate.command.slice(1).startsWith(normalizedQuery) ||
      candidate.label.toLocaleLowerCase('ko-KR').includes(normalizedQuery) ||
      candidate.keywords.some((keyword) =>
        keyword.toLocaleLowerCase('ko-KR').includes(normalizedQuery),
      ),
  );
}

interface AssistantComposerSlashMenuProps {
  suggestions: readonly ComposerSlashCommandSuggestion[];
  activeIndex: number;
  statusOpen: boolean;
  goalSnapshot: GoalSnapshot | null;
  isBusy: boolean;
  isRunning: boolean;
  modelId: RunModelId;
  reasoningEffort: RunReasoningSelection;
  contextUsage: ContextUsageUpdatedEventPayload | null;
  workingDirectoryLabel: string;
  onSelect: (id: ComposerSlashCommandId) => void;
  onBackFromStatus: () => void;
}

export function AssistantComposerSlashMenu({
  suggestions,
  activeIndex,
  statusOpen,
  goalSnapshot,
  isBusy,
  isRunning,
  modelId,
  reasoningEffort,
  contextUsage,
  workingDirectoryLabel,
  onSelect,
  onBackFromStatus,
}: AssistantComposerSlashMenuProps) {
  const runStateLabel = isRunning ? '실행 중' : isBusy ? '준비 중' : '대기 중';
  const reasoningLabel =
    reasoningEffort === 'ultra'
      ? 'Ultra'
      : REASONING_EFFORT_LABELS[reasoningEffort];

  if (statusOpen) {
    return (
      <div
        id="assistant-composer-slash-menu"
        className="composer-slash-menu"
        role="dialog"
        aria-label="현재 작업 상태"
      >
        <button
          type="button"
          className="composer-slash-back"
          onClick={onBackFromStatus}
        >
          <span aria-hidden="true">‹</span>
          <span>현재 상태</span>
        </button>
        <dl className="composer-slash-status">
          <StatusRow label="작업" value={runStateLabel} />
          <StatusRow
            label="모델"
            value={`${formatRunModelLabel(modelId)} · 사고 ${reasoningLabel}`}
          />
          <StatusRow
            label="컨텍스트"
            value={formatContextUsageSummary(contextUsage, modelId)}
          />
          <StatusRow label="시작 위치" value={workingDirectoryLabel} />
        </dl>
      </div>
    );
  }

  return (
    <div
      id="assistant-composer-slash-menu"
      className="composer-slash-menu"
      role="listbox"
      aria-label="슬래시 명령"
    >
      <div className="composer-slash-heading">명령</div>
      {suggestions.length === 0 ? (
        <div className="composer-slash-empty">일치하는 명령이 없어요.</div>
      ) : (
        suggestions.map((suggestion, index) => (
          <button
            id={`assistant-composer-slash-option-${suggestion.id}`}
            key={suggestion.id}
            type="button"
            className={`composer-slash-option${
              index === activeIndex ? ' active' : ''
            }`}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(suggestion.id)}
          >
            <span className="composer-slash-icon" aria-hidden="true">
              <SlashCommandIcon command={suggestion.id} />
            </span>
            <span className="composer-slash-copy">
              <span className="composer-slash-title">
                <strong>{suggestion.label}</strong>
                <code>{suggestion.command}</code>
              </span>
              <span className="composer-slash-description">
                {describeCommand(suggestion.id, goalSnapshot, runStateLabel)}
              </span>
            </span>
          </button>
        ))
      )}
      <div className="composer-slash-hint">
        <span>↑↓ 이동</span>
        <span>Enter 선택</span>
        <span>Esc 닫기</span>
      </div>
    </div>
  );
}

function describeCommand(
  command: ComposerSlashCommandId,
  goalSnapshot: GoalSnapshot | null,
  runStateLabel: string,
): string {
  switch (command) {
    case 'goal':
      return goalSnapshot === null
        ? '계속 추구할 목표를 새로 설정합니다'
        : `${GOAL_STATE_LABELS[goalSnapshot.state]} · ${goalSnapshot.objective}`;
    case 'skills':
      return '설치된 스킬과 사용 가능한 스킬을 살펴봅니다';
    case 'mcp':
      return 'MCP 서버와 연결된 도구를 관리합니다';
    case 'status':
      return `${runStateLabel} · 모델, 컨텍스트와 시작 위치를 봅니다`;
  }
}

function StatusRow(props: { label: string; value: string }) {
  return (
    <div className="composer-slash-status-row">
      <dt>{props.label}</dt>
      <dd title={props.value}>{props.value}</dd>
    </div>
  );
}

function SlashCommandIcon(props: { command: ComposerSlashCommandId }) {
  const path =
    props.command === 'goal'
      ? 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 11a1 1 0 1 0 1 1'
      : props.command === 'skills'
        ? 'M9.5 3.5 11 7l3.5 1.5L11 10l-1.5 3.5L8 10 4.5 8.5 8 7Zm7 8 1 2.5L20 15l-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z'
        : props.command === 'mcp'
          ? 'M8 5H5v3m11-3h3v3M8 19H5v-3m11 3h3v-3M9 9h6v6H9Z'
          : 'M12 7v5l3 2M12 3a9 9 0 1 0 9 9';
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <path d={path} />
    </svg>
  );
}
