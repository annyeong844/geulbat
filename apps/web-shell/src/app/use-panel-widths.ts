import { tryParseJsonRecord } from '../lib/json.js';
import { useCallback, useRef, useState, type PointerEvent } from 'react';

const PANEL_WIDTH_LIMITS = {
  left: { min: 220, max: 520, default: 300 },
  right: { min: 320, max: 800, default: 420 },
} as const;

type PanelSide = keyof typeof PANEL_WIDTH_LIMITS;

const STORAGE_KEY = 'geulbat.shell.panel-widths';

function clampWidth(side: PanelSide, width: number): number {
  const { min, max } = PANEL_WIDTH_LIMITS[side];
  return Math.min(max, Math.max(min, Math.round(width)));
}

function readStoredWidths(): Record<PanelSide, number> {
  const fallback = {
    left: PANEL_WIDTH_LIMITS.left.default,
    right: PANEL_WIDTH_LIMITS.right.default,
  };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = tryParseJsonRecord(raw);
    if (!parsed.ok) {
      return fallback;
    }
    const storedWidths = parsed.value;
    return {
      left:
        typeof storedWidths.left === 'number'
          ? clampWidth('left', storedWidths.left)
          : fallback.left,
      right:
        typeof storedWidths.right === 'number'
          ? clampWidth('right', storedWidths.right)
          : fallback.right,
    };
  } catch {
    return fallback;
  }
}

function storeWidths(widths: Record<PanelSide, number>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // local preference persistence는 best-effort
  }
}

/**
 * 3영역 패널 폭 드래그 리사이즈. 폭은 local UI preference로 저장한다.
 * 역할/가시성 invariant(§2.1)는 유지 — 크기만 바뀐다.
 */
export function usePanelWidths(): {
  leftWidth: number;
  rightWidth: number;
  startResize: (side: PanelSide, event: PointerEvent<HTMLElement>) => void;
} {
  const [widths, setWidths] = useState(readStoredWidths);
  const dragRef = useRef<{
    side: PanelSide;
    startX: number;
    startWidth: number;
  } | null>(null);

  const startResize = useCallback(
    (side: PanelSide, event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      dragRef.current = {
        side,
        startX: event.clientX,
        startWidth: side === 'left' ? widths.left : widths.right,
      };

      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        const delta = moveEvent.clientX - drag.startX;
        // 좌측은 오른쪽으로 끌면 넓어지고, 우측은 왼쪽으로 끌면 넓어진다
        const next = clampWidth(
          drag.side,
          drag.side === 'left'
            ? drag.startWidth + delta
            : drag.startWidth - delta,
        );
        setWidths((prev) =>
          prev[drag.side] === next ? prev : { ...prev, [drag.side]: next },
        );
      };

      const handleUp = () => {
        dragRef.current = null;
        target.removeEventListener('pointermove', handleMove);
        target.removeEventListener('pointerup', handleUp);
        target.removeEventListener('pointercancel', handleUp);
        setWidths((prev) => {
          storeWidths(prev);
          return prev;
        });
      };

      target.addEventListener('pointermove', handleMove);
      target.addEventListener('pointerup', handleUp);
      target.addEventListener('pointercancel', handleUp);
    },
    [widths.left, widths.right],
  );

  return {
    leftWidth: widths.left,
    rightWidth: widths.right,
    startResize,
  };
}
