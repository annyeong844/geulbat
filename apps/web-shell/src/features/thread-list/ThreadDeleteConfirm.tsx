import type { ThreadSummary } from '@geulbat/protocol/threads';

interface Props {
  thread: ThreadSummary;
  busy: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
}

export function ThreadDeleteConfirm({
  thread,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <section className="thread-delete-confirm" role="alertdialog">
      <strong>Delete thread?</strong>
      <p>
        {thread.title ?? 'New Thread'} will be removed from Home session list.
      </p>
      <div className="thread-delete-confirm-actions">
        <button type="button" onClick={() => void onConfirm()} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
        <button type="button" onClick={() => void onCancel()} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
