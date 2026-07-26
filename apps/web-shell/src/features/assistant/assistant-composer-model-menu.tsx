import { useState } from 'react';
import {
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  RUN_MODEL_CATALOG,
  RUN_REASONING_EFFORTS,
  RUN_SERVICE_TIERS,
  resolveMaximumReasoningEffort,
  resolveRunModelDescriptor,
  type RunModelId,
  type RunReasoningSelection,
  type RunServiceTier,
  type RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';

import {
  REASONING_EFFORT_LABELS,
  RUN_MODEL_TAGLINES,
  SERVICE_TIER_LABELS,
} from './model-copy.js';
import {
  ComposerMenuButton,
  MenuBackRow,
  MenuNavRow,
  MenuOptionRow,
} from './composer-menu-rows.js';

const REASONING_EFFORT_NOTE =
  '더 높은 사고는 더 철저한 응답을 주지만, 시간이 더 오래 걸립니다.';
const QWEN_REASONING_EFFORT_NOTE =
  'Qwen3.8 Max Preview는 필수 사고 모델이며 현재 Token Plan API는 모든 단계에서 사고를 켭니다.';

type ModelMenuPage =
  | 'root'
  | 'effort'
  | 'speed'
  | 'subagent'
  | 'subagent-effort';

interface AssistantComposerModelMenuProps {
  active: boolean;
  isBusy: boolean;
  isRunning: boolean;
  modelId: RunModelId;
  reasoningEffort: RunReasoningSelection;
  serviceTier: RunServiceTier;
  subagentModelRouting: RunSubagentModelRouting;
  onToggle: () => void;
  onClose: () => void;
  onModelIdChange: (modelId: RunModelId) => void;
  onReasoningEffortChange: (effort: RunReasoningSelection) => void;
  onServiceTierChange: (serviceTier: RunServiceTier) => void;
  onSubagentModelRoutingChange: (routing: RunSubagentModelRouting) => void;
}

export function AssistantComposerModelMenu({
  active,
  isBusy,
  isRunning,
  modelId,
  reasoningEffort,
  serviceTier,
  subagentModelRouting,
  onToggle,
  onClose,
  onModelIdChange,
  onReasoningEffortChange,
  onServiceTierChange,
  onSubagentModelRoutingChange,
}: AssistantComposerModelMenuProps) {
  const [page, setPage] = useState<ModelMenuPage>('root');
  const model = resolveRunModelDescriptor(modelId);
  const effortLabel =
    reasoningEffort === 'ultra'
      ? 'Ultra'
      : REASONING_EFFORT_LABELS[reasoningEffort];
  const serviceTierLabel = SERVICE_TIER_LABELS[serviceTier];
  const fixedSubagentModel =
    subagentModelRouting.mode === 'fixed'
      ? resolveRunModelDescriptor(subagentModelRouting.choice.modelId)
      : null;
  const fixedSubagentEffort =
    subagentModelRouting.mode === 'fixed'
      ? subagentModelRouting.choice.reasoningEffort
      : undefined;
  const effectiveFixedSubagentEffort =
    fixedSubagentModel === null
      ? undefined
      : reasoningEffort === 'ultra'
        ? resolveMaximumReasoningEffort(fixedSubagentModel.id)
        : fixedSubagentEffort;
  const subagentValueLabel =
    fixedSubagentModel === null
      ? '자동'
      : `${fixedSubagentModel.label}${
          effectiveFixedSubagentEffort === undefined
            ? ''
            : ` ${REASONING_EFFORT_LABELS[effectiveFixedSubagentEffort]}`
        } 고정`;

  const toggleMenu = () => {
    setPage('root');
    onToggle();
  };

  const closeMenu = () => {
    setPage('root');
    onClose();
  };

  return (
    <ComposerMenuButton
      label={`${model.label} ${effortLabel}`}
      title="모델, 사고 강도와 속도"
      active={active}
      onToggle={toggleMenu}
    >
      {active ? (
        <div className="composer-menu align-right" role="menu">
          {page === 'root' ? (
            <>
              {RUN_MODEL_CATALOG.map((option) => (
                <MenuOptionRow
                  key={option.id}
                  title={option.label}
                  description={RUN_MODEL_TAGLINES[option.id]}
                  checked={option.id === modelId}
                  disabled={option.id !== modelId && (isBusy || isRunning)}
                  onClick={() => {
                    onModelIdChange(option.id);
                    closeMenu();
                  }}
                />
              ))}
              <div className="context-menu-divider" />
              <MenuNavRow
                label="사고 강도"
                value={effortLabel}
                onClick={() => setPage('effort')}
              />
              <MenuNavRow
                label="속도"
                value={serviceTierLabel}
                onClick={() => setPage('speed')}
              />
              <MenuNavRow
                label="서브에이전트"
                value={subagentValueLabel}
                onClick={() => setPage('subagent')}
              />
            </>
          ) : null}

          {page === 'effort' ? (
            <>
              <MenuBackRow label="사고 강도" onClick={() => setPage('root')} />
              <div className="composer-menu-note">{REASONING_EFFORT_NOTE}</div>
              {model.id === 'qwen3.8-max-preview' ? (
                <div className="composer-menu-note">
                  {QWEN_REASONING_EFFORT_NOTE}
                </div>
              ) : null}
              {RUN_REASONING_EFFORTS.filter((effort) =>
                model.reasoningEfforts.some(
                  (candidate) => candidate === effort,
                ),
              ).map((effort) => (
                <MenuOptionRow
                  key={effort}
                  title={REASONING_EFFORT_LABELS[effort]}
                  {...(effort === model.defaultReasoningEffort
                    ? { badge: '기본값' }
                    : {})}
                  checked={effort === reasoningEffort}
                  onClick={() => {
                    onReasoningEffortChange(effort);
                    closeMenu();
                  }}
                />
              ))}
              <MenuOptionRow
                title="Ultra"
                checked={reasoningEffort === 'ultra'}
                disabled={reasoningEffort !== 'ultra' && (isBusy || isRunning)}
                onClick={() => {
                  onReasoningEffortChange('ultra');
                  closeMenu();
                }}
              />
            </>
          ) : null}

          {page === 'speed' ? (
            <>
              <MenuBackRow label="속도" onClick={() => setPage('root')} />
              {RUN_SERVICE_TIERS.map((tier) => {
                const supported = model.serviceTiers.some(
                  (candidate) => candidate === tier,
                );
                return (
                  <MenuOptionRow
                    key={tier}
                    title={SERVICE_TIER_LABELS[tier]}
                    description={
                      tier === 'fast'
                        ? supported
                          ? '지원되는 GPT 요청을 더 빠르게 처리'
                          : '현재 모델에서 지원되지 않음'
                        : '기본 처리 속도와 사용량'
                    }
                    checked={tier === serviceTier}
                    disabled={!supported}
                    onClick={() => {
                      onServiceTierChange(tier);
                      closeMenu();
                    }}
                  />
                );
              })}
            </>
          ) : null}

          {page === 'subagent' ? (
            <>
              <MenuBackRow
                label="서브에이전트"
                onClick={() => setPage('root')}
              />
              <div className="composer-menu-note">
                보조 작업(worker·explorer)이 어떤 모델을 쓸지 정합니다.
              </div>
              <MenuOptionRow
                title="자동"
                description="호출하는 에이전트가 모델을 고릅니다"
                checked={subagentModelRouting.mode === 'auto'}
                onClick={() => {
                  onSubagentModelRoutingChange(
                    DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
                  );
                  closeMenu();
                }}
              />
              {RUN_MODEL_CATALOG.map((option) => (
                <MenuOptionRow
                  key={option.id}
                  title={`${option.label} 고정`}
                  description={RUN_MODEL_TAGLINES[option.id]}
                  checked={
                    subagentModelRouting.mode === 'fixed' &&
                    subagentModelRouting.choice.modelId === option.id
                  }
                  onClick={() => {
                    onSubagentModelRoutingChange({
                      mode: 'fixed',
                      choice: { modelId: option.id },
                    });
                    setPage('subagent-effort');
                  }}
                />
              ))}
              {subagentModelRouting.mode === 'fixed' ? (
                <MenuNavRow
                  label="고정 모델 사고 강도"
                  value={
                    effectiveFixedSubagentEffort === undefined
                      ? '기본'
                      : REASONING_EFFORT_LABELS[effectiveFixedSubagentEffort]
                  }
                  onClick={() => setPage('subagent-effort')}
                />
              ) : null}
            </>
          ) : null}

          {page === 'subagent-effort' &&
          subagentModelRouting.mode === 'fixed' &&
          fixedSubagentModel !== null ? (
            <>
              <MenuBackRow
                label={`${fixedSubagentModel.label} 사고 강도`}
                onClick={() => setPage('subagent')}
              />
              {reasoningEffort !== 'ultra' ? (
                <MenuOptionRow
                  title="기본"
                  description={`${fixedSubagentModel.label} 기본 사고 강도`}
                  checked={fixedSubagentEffort === undefined}
                  onClick={() => {
                    onSubagentModelRoutingChange({
                      mode: 'fixed',
                      choice: {
                        modelId: subagentModelRouting.choice.modelId,
                      },
                    });
                    closeMenu();
                  }}
                />
              ) : null}
              {RUN_REASONING_EFFORTS.filter(
                (effort) =>
                  fixedSubagentModel.reasoningEfforts.some(
                    (candidate) => candidate === effort,
                  ) &&
                  (reasoningEffort !== 'ultra' ||
                    effort ===
                      resolveMaximumReasoningEffort(fixedSubagentModel.id)),
              ).map((effort) => (
                <MenuOptionRow
                  key={effort}
                  title={REASONING_EFFORT_LABELS[effort]}
                  {...(effort === fixedSubagentModel.defaultReasoningEffort
                    ? { badge: '기본값' }
                    : {})}
                  checked={effort === effectiveFixedSubagentEffort}
                  onClick={() => {
                    onSubagentModelRoutingChange({
                      mode: 'fixed',
                      choice: {
                        modelId: subagentModelRouting.choice.modelId,
                        reasoningEffort: effort,
                      },
                    });
                    closeMenu();
                  }}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </ComposerMenuButton>
  );
}
