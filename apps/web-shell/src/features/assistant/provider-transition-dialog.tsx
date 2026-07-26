import { resolveRunModelDescriptor } from '@geulbat/protocol/run-contract';

import type { PendingProviderTransition } from './use-assistant-provider-transition.js';

// 제공자 전환 문맥 압축 확인 모달. useAssistantProviderTransition 훅의 출력만으로
// 완결되고 Assistant 본문의 다른 상태와 얽히지 않아, 렌더를 통째로 이 컴포넌트로
// 분리한다. pending이 없거나 복구가 필요 없으면 아무것도 그리지 않는다.
interface ProviderTransitionDialogProps {
  pending: PendingProviderTransition | null;
  recoveryRequired: boolean;
  transitionPending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ProviderTransitionDialog({
  pending,
  recoveryRequired,
  transitionPending,
  error,
  onCancel,
  onConfirm,
}: ProviderTransitionDialogProps) {
  if (pending === null || !recoveryRequired) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        aria-label="제공자 전환 문맥 압축 취소"
        className="video-settings-backdrop"
        disabled={transitionPending}
        onClick={onCancel}
      />
      <section
        className="video-settings-card provider-transition-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="provider-transition-title"
        aria-describedby="provider-transition-description"
      >
        <div className="video-settings-header">
          <h2 id="provider-transition-title" className="video-settings-title">
            대화 문맥을 압축할까요?
          </h2>
        </div>
        <p
          id="provider-transition-description"
          className="provider-transition-description"
        >
          {resolveRunModelDescriptor(pending.sourceModelId).label}
          에서 전환한 {resolveRunModelDescriptor(pending.targetModelId).label}
          모델이 원문 대화를 그대로 이어갈 수 없어요. 대상 문맥 한계를 넘었거나
          제공자 고유 reasoning/tool-call 순서를 안전하게 보존할 수 없습니다.{' '}
          {resolveRunModelDescriptor(pending.sourceModelId).label}
          이 선택한 모델도 읽을 수 있는 handoff를 만든 뒤 다시 시도할 수 있어요.
          원본 대화 기록은 삭제하지 않습니다.
        </p>
        {error !== null ? (
          <p className="provider-transition-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="provider-transition-actions">
          <button
            type="button"
            className="provider-transition-cancel"
            disabled={transitionPending}
            onClick={onCancel}
          >
            압축 안 함
          </button>
          <button
            type="button"
            className="video-settings-save"
            disabled={transitionPending}
            onClick={onConfirm}
          >
            {transitionPending ? '문맥 준비 중…' : '압축 후 다시 시도'}
          </button>
        </div>
      </section>
    </>
  );
}
