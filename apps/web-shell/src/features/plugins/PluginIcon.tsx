import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  src?: string | null;
  size?: 'small' | 'medium';
  defer?: boolean;
}

const deferredIconCallbacks = new Map<Element, () => void>();
let deferredIconObserver: IntersectionObserver | null = null;

function releaseDeferredIconObserverIfIdle(): void {
  if (deferredIconCallbacks.size !== 0 || deferredIconObserver === null) {
    return;
  }
  deferredIconObserver.disconnect();
  deferredIconObserver = null;
}

function observeDeferredIcon(target: Element, onVisible: () => void) {
  deferredIconObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      const callback = deferredIconCallbacks.get(entry.target);
      if (!callback) {
        continue;
      }
      deferredIconCallbacks.delete(entry.target);
      deferredIconObserver?.unobserve(entry.target);
      callback();
    }
    releaseDeferredIconObserverIfIdle();
  });
  deferredIconCallbacks.set(target, onVisible);
  deferredIconObserver.observe(target);
  return () => {
    deferredIconCallbacks.delete(target);
    deferredIconObserver?.unobserve(target);
    releaseDeferredIconObserverIfIdle();
  };
}

export function PluginIcon({
  label,
  src = null,
  size = 'medium',
  defer = false,
}: Props) {
  const canDefer =
    defer &&
    src !== null &&
    typeof globalThis.IntersectionObserver === 'function';
  const [visible, setVisible] = useState(!canDefer);
  const hostRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!canDefer || visible || hostRef.current === null) {
      return;
    }
    return observeDeferredIcon(hostRef.current, () => setVisible(true));
  }, [canDefer, visible]);

  const fallback = label.trim().slice(0, 1).toLocaleUpperCase() || '◇';
  return (
    <span ref={hostRef} className={`extension-icon ${size}`} aria-hidden="true">
      <span>{fallback}</span>
      {src && (!canDefer || visible) ? (
        <img
          src={src}
          alt=""
          decoding="async"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
    </span>
  );
}
