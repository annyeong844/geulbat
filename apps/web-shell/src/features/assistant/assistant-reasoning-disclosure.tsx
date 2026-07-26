interface ReasoningDisclosureProps {
  text: string;
  live?: boolean;
}

export function ReasoningDisclosure({
  text,
  live = false,
}: ReasoningDisclosureProps) {
  return (
    <details
      className={`reasoning-disclosure${live ? ' live' : ''}`}
      {...(live ? { open: true } : {})}
    >
      <summary>
        <span className="reasoning-disclosure-chevron" aria-hidden="true">
          ›
        </span>
        <span>{live ? '생각 중…' : '추론'}</span>
      </summary>
      <pre className="reasoning-disclosure-content">{text}</pre>
    </details>
  );
}
