import { useState } from 'react';
import type {
  PlanModeDepth,
  PlanModeIntensity,
} from '@geulbat/protocol/planning-workflow';
import type { PermissionMode } from '@geulbat/protocol/run-approval';

import {
  ComposerMenuButton,
  MenuBackRow,
  MenuNavRow,
  MenuOptionRow,
} from './composer-menu-rows.js';

const APPROVAL_PERMISSION_OPTIONS: ReadonlyArray<{
  value: PermissionMode;
  pillLabel: string;
  warning: boolean;
}> = [
  {
    value: 'basic',
    pillLabel: '수동 승인',
    warning: false,
  },
  {
    value: 'full_access',
    pillLabel: '승인 건너뛰기',
    warning: true,
  },
];

type PermissionMenuPage = 'root' | 'plan-depth' | 'plan-presentation';

interface AssistantComposerApprovalMenuProps {
  active: boolean;
  permissionMode: PermissionMode;
  planModeRequested: boolean;
  planModeIntensity: PlanModeIntensity;
  planModeDepth: PlanModeDepth;
  onToggle: () => void;
  onClose: () => void;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void> | void;
  onPlanModeRequestedChange: (planModeRequested: boolean) => void;
  onPlanModeIntensityChange: (intensity: PlanModeIntensity) => void;
  onPlanModeDepthChange: (depth: PlanModeDepth) => void;
}

export function AssistantComposerApprovalMenu({
  active,
  permissionMode,
  planModeRequested,
  planModeIntensity,
  planModeDepth,
  onToggle,
  onClose,
  onPermissionModeChange,
  onPlanModeRequestedChange,
  onPlanModeIntensityChange,
  onPlanModeDepthChange,
}: AssistantComposerApprovalMenuProps) {
  const [page, setPage] = useState<PermissionMenuPage>('root');
  const [pendingPlanDepth, setPendingPlanDepth] =
    useState<PlanModeDepth>(planModeDepth);
  const planDepthLabel = planModeDepth === 'deep' ? '심층' : '일반';
  const planPresentationLabel = planModeIntensity === 'quiet' ? '간편' : '시각';
  const approvalOption = planModeRequested
    ? {
        pillLabel: `${planDepthLabel}·${planPresentationLabel}`,
        warning: false,
      }
    : (APPROVAL_PERMISSION_OPTIONS.find(
        (option) => option.value === permissionMode,
      ) ?? APPROVAL_PERMISSION_OPTIONS[0]!);

  const toggleMenu = () => {
    setPage('root');
    setPendingPlanDepth(planModeDepth);
    onToggle();
  };

  const closeMenu = () => {
    setPage('root');
    onClose();
  };

  const selectPermissionMode = (next: PermissionMode): void => {
    onPlanModeRequestedChange(false);
    // 저장은 daemon이 소유한다. 실패하면 런타임이 소유자 값으로 되돌린다.
    void onPermissionModeChange(next);
  };

  return (
    <ComposerMenuButton
      label={`${approvalOption.warning ? '⚠ ' : ''}${approvalOption.pillLabel}`}
      title="승인 방식"
      active={active}
      emphasis={approvalOption.warning}
      onToggle={toggleMenu}
    >
      {active ? (
        <div className="composer-menu" role="menu">
          {page === 'root' ? (
            <>
              <MenuOptionRow
                title="수동 승인"
                description="위험한 작업마다 일시 중지하고 승인을 요청합니다."
                checked={!planModeRequested && permissionMode === 'basic'}
                onClick={() => {
                  selectPermissionMode('basic');
                  closeMenu();
                }}
              />
              <MenuNavRow
                label="계획 모드"
                value={
                  planModeRequested
                    ? `${planDepthLabel} · ${planPresentationLabel}`
                    : '꺼짐'
                }
                onClick={() => {
                  setPendingPlanDepth(planModeDepth);
                  setPage('plan-depth');
                }}
              />
              <MenuOptionRow
                title="⚠ 모든 승인 건너뛰기"
                description="안전하지 않은 작업이라도 일시 중지하지 않습니다."
                warning
                checked={!planModeRequested && permissionMode === 'full_access'}
                onClick={() => {
                  selectPermissionMode('full_access');
                  closeMenu();
                }}
              />
            </>
          ) : null}

          {page === 'plan-depth' ? (
            <>
              <MenuBackRow label="조사 깊이" onClick={() => setPage('root')} />
              <MenuOptionRow
                title="일반"
                description="실제로 계획을 바꾸는 결정만 질문합니다."
                checked={pendingPlanDepth === 'standard'}
                onClick={() => {
                  setPendingPlanDepth('standard');
                  setPage('plan-presentation');
                }}
              />
              <MenuOptionRow
                title="심층"
                description="중요한 선택을 질문 카드로 적극 확인합니다."
                checked={pendingPlanDepth === 'deep'}
                onClick={() => {
                  setPendingPlanDepth('deep');
                  setPage('plan-presentation');
                }}
              />
            </>
          ) : null}

          {page === 'plan-presentation' ? (
            <>
              <MenuBackRow
                label="표현 방식"
                onClick={() => setPage('plan-depth')}
              />
              <MenuOptionRow
                title="간편"
                description="간결한 텍스트와 가정 목록으로 정리합니다."
                checked={planModeIntensity === 'quiet'}
                onClick={() => {
                  onPlanModeDepthChange(pendingPlanDepth);
                  onPlanModeIntensityChange('quiet');
                  onPlanModeRequestedChange(true);
                  closeMenu();
                }}
              />
              <MenuOptionRow
                title="시각"
                description="경계와 흐름을 검색 가능한 설명과 그림으로 정리합니다."
                checked={planModeIntensity === 'visual'}
                onClick={() => {
                  onPlanModeDepthChange(pendingPlanDepth);
                  onPlanModeIntensityChange('visual');
                  onPlanModeRequestedChange(true);
                  closeMenu();
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </ComposerMenuButton>
  );
}
