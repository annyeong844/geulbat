import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// 가상 스크롤 — 보이는 행만 DOM에 그린다 (대형 폴더 네이티브급).
// ComputerTree에서 분리한 스크롤 계층: 행 데이터와 행 높이만 받고,
// 스크롤 컨테이너 ref·rAF 스로틀 onScroll·가시 창을 돌려준다.
export function useTreeVirtualScroll<T>(rows: readonly T[], rowHeight: number) {
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const scrollFrameRef = useRef<number | null>(null);
  const handleTreeScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(treeScrollRef.current?.scrollTop ?? 0);
    });
  }, []);
  useEffect(() => {
    const el = treeScrollRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const visibleWindow = useMemo(() => {
    const overscan = 12;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(
      rows.length,
      Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
    );
    return { start, end, rows: rows.slice(start, end) };
  }, [rowHeight, rows, scrollTop, viewportHeight]);

  return { treeScrollRef, visibleWindow, handleTreeScroll };
}
