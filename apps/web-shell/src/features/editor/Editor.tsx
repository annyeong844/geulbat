import { useEffect, useCallback } from 'react';
import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import {
  editorConflictForceSaveButtonStyle,
  editorConflictReloadButtonStyle,
  editorStyles,
  getEditorSaveButtonStyle,
} from './editor-styles.js';

interface Props {
  filePath: string | null;
  content: string;
  isDirty: boolean;
  saving: boolean;
  uiError: string | null;
  saveConflict: ConflictStaleWriteError | null;
  onChange: (content: string) => void;
  onSave: () => Promise<void> | void;
  onConflictReload: () => Promise<void> | void;
  onConflictForceSave: () => Promise<void> | void;
}

export function Editor({
  filePath,
  content,
  isDirty,
  saving,
  uiError,
  saveConflict,
  onChange,
  onSave,
  onConflictReload,
  onConflictForceSave,
}: Props) {
  // Cmd/Ctrl+S keyboard shortcut
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!filePath || !isDirty || saving) return;
        void onSave();
      }
    },
    [filePath, isDirty, saving, onSave],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!filePath) {
    return (
      <section className="editor" style={editorStyles.section}>
        {uiError ? (
          <div role="alert" style={editorStyles.alert}>
            {uiError}
          </div>
        ) : null}
        <p style={editorStyles.emptyState}>Open a file from the project tree</p>
      </section>
    );
  }

  return (
    <section className="editor" style={editorStyles.section}>
      {uiError ? (
        <div role="alert" style={editorStyles.inlineAlert}>
          {uiError}
        </div>
      ) : null}
      {/* Header bar */}
      <div style={editorStyles.headerBar}>
        <span style={editorStyles.pathLabel}>
          {filePath}
          {isDirty ? ' *' : ''}
        </span>
        <button
          onClick={() => void onSave()}
          disabled={!isDirty || saving}
          style={getEditorSaveButtonStyle(isDirty && !saving)}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Conflict banner */}
      {saveConflict && (
        <div
          role="alert"
          aria-live="assertive"
          style={editorStyles.conflictBanner}
        >
          <strong>Conflict:</strong> File was modified on disk.
          <div style={editorStyles.conflictActionRow}>
            <button
              onClick={() => void onConflictReload()}
              style={editorConflictReloadButtonStyle}
            >
              Reload (discard my changes)
            </button>
            <button
              onClick={() => void onConflictForceSave()}
              style={editorConflictForceSaveButtonStyle}
            >
              Force Save (overwrite)
            </button>
          </div>
        </div>
      )}

      {/* Editable textarea */}
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={editorStyles.textarea}
      />
    </section>
  );
}
