// OS 저장 대화상자로 텍스트를 로컬 파일에 저장한다. showSaveFilePicker가
// 없는 브라우저에서는 기본 다운로드(다운로드 폴더)로 폴백한다.
// 반환값: 저장했으면 true, 사용자가 대화상자를 취소했으면 false.

interface SaveFilePickerWritable {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface SaveFilePickerHandle {
  createWritable: () => Promise<SaveFilePickerWritable>;
}

// File System Access API — 아직 lib.dom에 없어 전역 선언으로 보강한다
// (크로미움 전용, 없으면 undefined).
declare global {
  interface Window {
    showSaveFilePicker?: (options: {
      suggestedName?: string;
    }) => Promise<SaveFilePickerHandle>;
  }
}

export async function saveTextToLocalFile(args: {
  suggestedName: string;
  payload: string;
}): Promise<boolean> {
  const blob = new Blob([args.payload], { type: 'text/plain;charset=utf-8' });

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: args.suggestedName,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false;
      }
      throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = args.suggestedName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return true;
}
