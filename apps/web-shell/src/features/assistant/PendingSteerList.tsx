import type { PendingSteer } from '../../lib/run-channel/pending-steer.js';

/**
 * 실행 중에 보낸 말들이 모여 있는 자리.
 *
 * 말풍선은 대화에 흩어져 앉는다 — 답변과 도구 줄 사이사이로. 그래서 여러 개를
 * 보냈을 때 "내가 뭘 걸어뒀더라"를 한눈에 보고 지우려면 모아 두는 자리가 따로
 * 있어야 한다. 여기가 그 자리다.
 *
 * 대기라는 사실은 줄마다 적지 않는다. 컴포저 위에 강조선을 달고 잡혀 있다는
 * 것이 이미 대기이고, 같은 설명을 줄 수만큼 반복하면 정작 읽어야 할 내 말이
 * 밀린다.
 */
export function PendingSteerList(props: {
  steers: readonly PendingSteer[];
  onCancel: (receivedSeq: number) => void;
  onFlush?: () => void;
  flushRequested?: boolean;
}) {
  const { steers, onCancel, onFlush, flushRequested = false } = props;
  if (steers.length === 0) {
    return null;
  }

  // 순번은 여럿일 때만 — 하나뿐인데 "1"을 붙이면 뜻 없는 글자가 하나 는다.
  const showOrder = steers.length > 1;

  return (
    <div className="pending-steer-list">
      {steers.map((steer, index) => (
        <div className="pending-steer-row" key={steer.receivedSeq}>
          {showOrder ? (
            <span className="pending-steer-order" aria-hidden="true">
              {index + 1}
            </span>
          ) : null}
          <span className="pending-steer-text">{steer.text}</span>
          <button
            type="button"
            className="pending-steer-action"
            title="대기 중 메시지 되돌리기"
            aria-label="대기 중 메시지 되돌리기"
            onClick={() => onCancel(steer.receivedSeq)}
          >
            <CancelIcon />
          </button>
        </div>
      ))}
      {onFlush !== undefined && !flushRequested ? (
        <button
          type="button"
          className="pending-steer-flush"
          title="대화에 올려 다음 소비 지점에 반영합니다"
          onClick={() => onFlush()}
        >
          {/* 위에서 내려와 왼쪽으로 꺾이는 화살표 — 줄 바꿔 넣는다는 뜻.
              대기하던 말을 대화에 넣는 동작과 같은 모양이다. */}
          <span className="pending-steer-flush-glyph" aria-hidden="true">
            ↵
          </span>
          <span>대화에 올리기</span>
        </button>
      ) : null}
    </div>
  );
}

function CancelIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
