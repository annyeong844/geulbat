import { artifactPaneStyles, getInlineActionButtonStyle } from './styles.js';

export interface ArtifactPaneExportPanelProps {
  placeholder: string;
  value: string;
  canOpenExport: boolean;
  canSubmitExport: boolean;
  isPending: boolean;
  canOfferRememberedBinaryOverwrite: boolean;
  generatedBinaryOverwriteArmed: boolean;
  exportHint: string;
  error: string | null;
  onChangeValue: (nextValue: string) => void;
  onToggleOverwrite: (checked: boolean) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
}

export function ArtifactPaneExportPanel({
  placeholder,
  value,
  canOpenExport,
  canSubmitExport,
  isPending,
  canOfferRememberedBinaryOverwrite,
  generatedBinaryOverwriteArmed,
  exportHint,
  error,
  onChangeValue,
  onToggleOverwrite,
  onSubmit,
  onCancel,
}: ArtifactPaneExportPanelProps) {
  return (
    <form
      style={artifactPaneStyles.exportForm}
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={!canOpenExport || isPending}
        onChange={(event) => {
          onChangeValue(event.currentTarget.value);
        }}
        style={artifactPaneStyles.exportInput}
      />
      {canOfferRememberedBinaryOverwrite ? (
        <label style={artifactPaneStyles.exportHint}>
          <input
            type="checkbox"
            checked={generatedBinaryOverwriteArmed}
            disabled={isPending}
            onChange={(event) => {
              onToggleOverwrite(event.currentTarget.checked);
            }}
          />{' '}
          Overwrite the previously exported file at this path
        </label>
      ) : null}
      <div style={artifactPaneStyles.exportActions}>
        <button
          type="submit"
          disabled={!canSubmitExport}
          style={getInlineActionButtonStyle(canSubmitExport)}
        >
          {isPending
            ? 'Saving...'
            : generatedBinaryOverwriteArmed
              ? 'Overwrite export'
              : 'Start export'}
        </button>
        <button
          type="button"
          disabled={!canOpenExport || isPending}
          onClick={onCancel}
          style={getInlineActionButtonStyle(canOpenExport)}
        >
          Cancel
        </button>
      </div>
      <div style={artifactPaneStyles.exportHint}>{exportHint}</div>
      {error ? (
        <div style={artifactPaneStyles.fallbackBanner}>{error}</div>
      ) : null}
    </form>
  );
}
