import { useCallback, useState } from 'react';

import type { ComposerAttachment } from './AssistantComposer.js';

interface ComposerAttachments {
  attachments: ComposerAttachment[];
  uploadPending: boolean;
  uploadFiles: (files: FileList) => Promise<void>;
  removeAttachment: (contentRef: string) => void;
  // 전송 성공 후 큐를 비운다 — 미리보기 objectURL을 반드시 회수한다.
  clear: () => void;
}

// 다음 메시지에 실을 첨부 큐의 생명주기 — 업로드 진행 상태, 목록 추가/제거,
// 미리보기 objectURL 회수를 한곳에서 소유한다. 전송 자체(handleSend)는
// Assistant가 오케스트레이션하며, 성공 시 clear()로 큐를 비운다.
export function useComposerAttachments({
  onUploadFiles,
  onDiscardUploadedAttachment,
}: {
  onUploadFiles:
    | ((files: FileList) => Promise<ComposerAttachment[]>)
    | undefined;
  onDiscardUploadedAttachment: ((contentRef: string) => void) | undefined;
}): ComposerAttachments {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadPending, setUploadPending] = useState(false);

  const uploadFiles = useCallback(
    async (files: FileList) => {
      if (onUploadFiles === undefined) {
        return;
      }
      setUploadPending(true);
      try {
        const uploaded = await onUploadFiles(files);
        setAttachments((prev) => [...prev, ...uploaded]);
      } finally {
        setUploadPending(false);
      }
    },
    [onUploadFiles],
  );

  const removeAttachment = useCallback(
    (contentRef: string) => {
      setAttachments((prev) => {
        const removed = prev.find(
          (attachment) => attachment.contentRef === contentRef,
        );
        if (removed?.previewUrl !== undefined) {
          URL.revokeObjectURL(removed.previewUrl);
        }
        return prev.filter(
          (attachment) => attachment.contentRef !== contentRef,
        );
      });
      onDiscardUploadedAttachment?.(contentRef);
    },
    [onDiscardUploadedAttachment],
  );

  const clear = useCallback(() => {
    setAttachments((prev) => {
      for (const attachment of prev) {
        if (attachment.previewUrl !== undefined) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      return [];
    });
  }, []);

  return { attachments, uploadPending, uploadFiles, removeAttachment, clear };
}
