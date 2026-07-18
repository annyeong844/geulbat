import type { ReactNode } from 'react';

export function ComposerMenuButton(props: {
  label: string;
  title: string;
  active: boolean;
  emphasis?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <span className="composer-menu-anchor">
      <button
        type="button"
        className={[
          'composer-pill',
          props.active ? 'active' : '',
          props.emphasis ? 'emphasis' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title={props.title}
        onClick={props.onToggle}
      >
        {props.label}
      </button>
      {props.children}
    </span>
  );
}

// 클로드식 2줄 옵션 — 제목(+뱃지) 줄과 회색 설명 줄, 오른쪽 ✓
export function MenuOptionRow(props: {
  title: string;
  description?: string;
  badge?: string;
  checked?: boolean;
  warning?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={[
        'context-menu-item',
        'menu-option',
        props.warning ? 'warning' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={props.disabled ?? false}
      onClick={props.onClick}
    >
      <span className="menu-option-main">
        <span className="menu-option-title">
          {props.title}
          {props.badge !== undefined ? (
            <span className="menu-badge">{props.badge}</span>
          ) : null}
        </span>
        {props.description !== undefined ? (
          <span className="menu-option-desc">{props.description}</span>
        ) : null}
      </span>
      {props.checked ? <span className="menu-option-check">✓</span> : null}
    </button>
  );
}

// 서브패널로 들어가는 행 — 현재 값과 › 를 오른쪽에 보여준다
export function MenuNavRow(props: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu-item menu-nav-row"
      onClick={props.onClick}
    >
      <span className="menu-option-title">{props.label}</span>
      <span className="menu-nav-value">
        {props.value} <span aria-hidden="true">›</span>
      </span>
    </button>
  );
}

export function MenuBackRow(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu-item menu-back-row"
      onClick={props.onClick}
    >
      <span aria-hidden="true">‹</span> {props.label}
    </button>
  );
}
