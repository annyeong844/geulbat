import { useState } from 'react';

import type { AskUserCardView } from './ask-user-card-view.js';

export interface AskUserAnswerRequest {
  answer: string;
  requestKey: string;
}

export type AskUserAnswerHandler = (
  request: AskUserAnswerRequest,
) => Promise<void> | void;

// 선택지 질문 카드 — 옵션 클릭이 그 라벨을 사용자 메시지로 보낸다
// (컴포저와 같은 전송 경로). 자유 답변은 늘 컴포저로 가능하다.
export function AskUserCard(props: {
  view: AskUserCardView;
  requestKey: string;
  onAnswer?: AskUserAnswerHandler;
}) {
  const { view, requestKey, onAnswer } = props;
  const [submitting, setSubmitting] = useState(false);

  const submitAnswer = async (answer: string): Promise<void> => {
    if (onAnswer === undefined || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onAnswer({ answer, requestKey });
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="ask-user-card">
      <div className="ask-user-question">{view.question}</div>
      <div className="ask-user-options" role="list">
        {view.options.map((option, index) => (
          <button
            key={`${index}:${option.label}`}
            type="button"
            role="listitem"
            className="ask-user-option"
            disabled={onAnswer === undefined || submitting}
            onClick={() => {
              void submitAnswer(option.label);
            }}
          >
            <span className="ask-user-option-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="ask-user-option-main">
              <span className="ask-user-option-label">{option.label}</span>
              {option.description !== null ? (
                <span className="ask-user-option-description">
                  {option.description}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
      <div className="ask-user-hint">
        다른 답은 아래 입력창에 직접 적어 주세요.
      </div>
    </div>
  );
}
