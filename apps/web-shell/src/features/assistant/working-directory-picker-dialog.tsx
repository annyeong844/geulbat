import { ComputerDirectoryPickerDialog } from '../../lib/computer-directory-picker-dialog.js';

import type { WorkingDirectoryOverlay } from './use-working-directory-picker.js';

// 시작 위치 선택 오버레이 렌더 — 브라우즈 다이얼로그 또는 실패 알림줄. 상태와
// 로직은 useWorkingDirectoryPicker가 갖고, 여기선 그 결과(overlay)만 그린다.
export function WorkingDirectoryPickerDialog({
  overlay,
}: {
  overlay: WorkingDirectoryOverlay;
}) {
  if (overlay === null) {
    return null;
  }
  if (overlay.kind === 'error') {
    return (
      <p className="working-directory-selection-error" role="alert">
        {overlay.message}
      </p>
    );
  }
  return (
    <ComputerDirectoryPickerDialog
      title="시작 위치 선택"
      confirmLabel="이 폴더 사용"
      initialPath={overlay.initialPath}
      browsePath={overlay.browsePath}
      browseStartPath={overlay.browseStartPath}
      browseShortcuts={overlay.browseShortcuts}
      recentDirectories={overlay.recentDirectories}
      favoriteDirectories={overlay.favoriteDirectories}
      onToggleFavorite={overlay.onToggleFavorite}
      onSelect={overlay.onSelect}
      onClose={overlay.onClose}
    />
  );
}
