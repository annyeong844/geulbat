import type { ShellLayoutModeId } from './home-shell.js';

// 레이아웃 모드 — ▥ 버튼에 마우스를 올리면 미니 다이어그램 + 라벨 메뉴로
// 고른다. HomeShell에서 분리한 순수 표현 컴포넌트 (2026-07-23).
const SHELL_LAYOUT_MODES = [
  { id: 'default', label: '기본 배치', hint: '탐색기 · 에디터 · 채팅' },
  { id: 'no-tree', label: '탐색기 접기', hint: '에디터 · 채팅' },
  { id: 'no-chat', label: '채팅 접기', hint: '탐색기 · 에디터' },
  { id: 'editor-only', label: '에디터만', hint: '에디터 전체 화면' },
  { id: 'chat-center', label: '채팅 가운데', hint: '탐색기 · 채팅' },
  { id: 'chat-only', label: '채팅만', hint: '채팅 전체 화면' },
] as const satisfies ReadonlyArray<{
  id: ShellLayoutModeId;
  label: string;
  hint: string;
}>;

// 미니 레이아웃 다이어그램 — 왼쪽 좁은 기둥이 탐색기, 빈 공간이 에디터,
// 진하게 칠해진 영역이 채팅이다.
function LayoutGlyph(props: { mode: ShellLayoutModeId }) {
  const { mode } = props;
  const showTree =
    mode === 'default' || mode === 'no-chat' || mode === 'chat-center';
  const showChat = mode !== 'no-chat' && mode !== 'editor-only';
  const chatX = mode === 'chat-only' ? 3 : mode === 'chat-center' ? 9.5 : 16.5;
  const chatWidth =
    mode === 'chat-only' ? 20 : mode === 'chat-center' ? 13.5 : 6.5;
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden>
      <rect
        x="1"
        y="1"
        width="24"
        height="16"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      {showTree ? (
        <rect
          x="3"
          y="3"
          width="4.5"
          height="12"
          rx="1"
          fill="currentColor"
          fillOpacity="0.3"
        />
      ) : null}
      {showChat ? (
        <rect
          x={chatX}
          y="3"
          width={chatWidth}
          height="12"
          rx="1"
          fill="currentColor"
          fillOpacity="0.7"
        />
      ) : null}
    </svg>
  );
}

// 레이아웃 선택 팝오버 — 호버/포커스에 뜨고, 클릭 즉시 적용된다.
export function ShellLayoutMenu(props: {
  mode: ShellLayoutModeId;
  onSelect: (mode: ShellLayoutModeId) => void;
  buttonClassName: string;
}) {
  const active =
    SHELL_LAYOUT_MODES.find((mode) => mode.id === props.mode) ??
    SHELL_LAYOUT_MODES[0];
  return (
    <span className="layout-menu-anchor">
      <button
        type="button"
        className={props.buttonClassName}
        title={`레이아웃 — 지금: ${active.label}`}
        aria-label="레이아웃 선택"
        aria-haspopup="true"
      >
        <LayoutGlyph mode={active.id} />
      </button>
      <span className="layout-menu" role="menu" aria-label="레이아웃 모드">
        {SHELL_LAYOUT_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="menuitemradio"
            aria-checked={mode.id === props.mode}
            className={`layout-menu-item${mode.id === props.mode ? ' active' : ''}`}
            title={mode.hint}
            onClick={(event) => {
              // 곧 inert가 될 패널 안에서 포커스가 갇히지 않도록 먼저 놓는다
              event.currentTarget.blur();
              props.onSelect(mode.id);
            }}
          >
            <LayoutGlyph mode={mode.id} />
            <span className="layout-menu-item-copy">
              <span className="layout-menu-item-label">{mode.label}</span>
              <span className="layout-menu-item-hint">{mode.hint}</span>
            </span>
          </button>
        ))}
      </span>
    </span>
  );
}
