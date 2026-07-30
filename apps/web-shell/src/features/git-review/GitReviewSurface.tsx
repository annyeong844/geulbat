import {
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  GitReviewComparisonSection,
  GitReviewDiffRow,
  GitReviewFileSummary,
} from '@geulbat/protocol/git-review';

import type { GitReviewController } from './use-git-review.js';

export function GitReviewSummaryTrigger(props: {
  summary: GitReviewController['changedSummary'];
  disabled: boolean;
  onOpen: () => void;
}) {
  const { summary, disabled, onOpen } = props;
  if (summary === null) {
    return null;
  }
  const totals = formatTotals(summary.totals);
  return (
    <button
      type="button"
      className="git-review-trigger"
      disabled={disabled}
      aria-label={`${summary.totals.fileCount.toLocaleString()}개 변경 파일 검토${totals === null ? '' : `, ${totals}`}`}
      onClick={onOpen}
    >
      <span className="git-review-trigger-icon" aria-hidden="true">
        ⊞
      </span>
      <span>{summary.totals.fileCount.toLocaleString()}개 파일 변경됨</span>
      {totals === null ? null : (
        <span className="git-review-trigger-totals" aria-hidden="true">
          {totals}
        </span>
      )}
    </button>
  );
}

export function GitReviewSurface(props: {
  controller: GitReviewController;
  onClose: () => void;
}) {
  const { controller, onClose } = props;
  const [filter, setFilter] = useState('');
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const files = useMemo(
    () => controller.changedSummary?.files.items ?? [],
    [controller.changedSummary],
  );
  const filteredFiles = useMemo(
    () =>
      normalizedFilter.length === 0
        ? files
        : files.filter((file) =>
            file.displayPath.toLocaleLowerCase().includes(normalizedFilter),
          ),
    [files, normalizedFilter],
  );
  const filteredFileIds = useMemo(
    () => filteredFiles.map((file) => file.fileId),
    [filteredFiles],
  );
  const selectedFileVisible = filteredFileIds.includes(
    controller.selectedFileId ?? '',
  );

  return (
    <section className="git-review" aria-label="Git 변경 검토">
      <header className="git-review-header">
        <div className="git-review-heading">
          <strong>변경 검토</strong>
          <span className="git-review-branch">
            {branchLabel(controller.changedSummary)}
          </span>
          {controller.changedSummary === null ? null : (
            <span className="git-review-total">
              {formatTotalsOrFiles(controller.changedSummary.totals)}
            </span>
          )}
        </div>
        <div className="git-review-header-actions">
          <button
            type="button"
            className="git-review-action"
            disabled={controller.summaryLoading}
            onClick={controller.refresh}
          >
            {controller.summaryLoading ? '새로 고치는 중…' : '새로 고침'}
          </button>
          <button
            type="button"
            className="settings-close"
            aria-label="검토 닫기"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      {controller.summaryLoading ? (
        <GitReviewNotice>변경 사항을 확인하고 있습니다…</GitReviewNotice>
      ) : controller.summaryError !== null ? (
        <GitReviewNotice actionLabel="다시 시도" onAction={controller.refresh}>
          {controller.summaryError}
        </GitReviewNotice>
      ) : controller.summary?.kind === 'clean' ? (
        <GitReviewNotice>현재 검토할 변경 사항이 없습니다.</GitReviewNotice>
      ) : controller.summary?.kind === 'not_reviewable' ? (
        <GitReviewNotice>
          이 시작 위치에서는 Git 변경 사항을 검토할 수 없습니다.
        </GitReviewNotice>
      ) : controller.summary?.kind === 'unavailable' ? (
        <GitReviewNotice actionLabel="다시 시도" onAction={controller.refresh}>
          현재 크기의 변경 사항을 안전하게 불러올 수 없습니다.
        </GitReviewNotice>
      ) : controller.summary?.kind === 'stale' ? (
        <GitReviewNotice actionLabel="새로 고침" onAction={controller.refresh}>
          검토 중 저장소가 변경되었습니다.
        </GitReviewNotice>
      ) : controller.changedSummary === null ? (
        <GitReviewNotice>검토할 저장소를 선택해 주세요.</GitReviewNotice>
      ) : (
        <div className="git-review-body">
          <div className="git-review-diff">
            <GitReviewFileBody controller={controller} />
          </div>
          <aside className="git-review-files" aria-label="변경 파일">
            <div className="git-review-files-heading">
              <strong>변경 파일</strong>
              <span>
                {controller.changedSummary.totals.fileCount.toLocaleString()}
              </span>
            </div>
            <label className="git-review-filter">
              <span className="sr-only">변경 파일 필터</span>
              <input
                type="search"
                value={filter}
                placeholder="파일 필터링…"
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
            </label>
            <div
              className="git-review-file-list"
              role="listbox"
              aria-label="변경 파일 목록"
            >
              {filteredFiles.map((file, index) => (
                <GitReviewFileOption
                  key={file.fileId}
                  file={file}
                  selected={file.fileId === controller.selectedFileId}
                  tabbable={
                    file.fileId === controller.selectedFileId ||
                    (!selectedFileVisible && index === 0)
                  }
                  index={index}
                  fileIds={filteredFileIds}
                  onSelect={controller.selectFile}
                />
              ))}
              {filteredFiles.length === 0 ? (
                <div className="git-review-filter-empty">
                  불러온 파일 중 일치하는 항목이 없습니다.
                </div>
              ) : null}
            </div>
            {controller.changedSummary.files.nextCursor === null ? null : (
              <div className="git-review-files-more">
                <span>필터는 지금까지 불러온 파일에만 적용됩니다.</span>
                <button
                  type="button"
                  className="git-review-action"
                  disabled={controller.summaryLoadingMore}
                  onClick={controller.loadMoreSummary}
                >
                  {controller.summaryLoadingMore
                    ? '불러오는 중…'
                    : '파일 더 보기'}
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function GitReviewFileOption(props: {
  file: GitReviewFileSummary;
  selected: boolean;
  tabbable: boolean;
  index: number;
  fileIds: string[];
  onSelect: (fileId: string) => void;
}) {
  const { file, selected, tabbable, index, fileIds, onSelect } = props;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowUp':
        nextIndex = (index - 1 + fileIds.length) % fileIds.length;
        break;
      case 'ArrowDown':
        nextIndex = (index + 1) % fileIds.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = fileIds.length - 1;
        break;
      default:
        return;
    }
    const nextFileId = fileIds[nextIndex];
    if (nextFileId === undefined) {
      return;
    }
    event.preventDefault();
    onSelect(nextFileId);
    event.currentTarget
      .closest('[role="listbox"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="option"]')
      [nextIndex]?.focus();
  };

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      className={`git-review-file${selected ? ' selected' : ''}`}
      title={file.displayPath}
      onClick={() => onSelect(file.fileId)}
      onKeyDown={handleKeyDown}
    >
      <span className="git-review-file-path">{file.displayPath}</span>
      <span className="git-review-file-layers">
        {file.layers.map((layer) => (
          <span key={layer.layerId}>
            {comparisonLabel(layer.comparison)} · {stateLabel(layer.state)}
            {layer.beforeDisplayPath !== null &&
            layer.afterDisplayPath !== null &&
            layer.beforeDisplayPath !== layer.afterDisplayPath
              ? ` · ${layer.beforeDisplayPath} → ${layer.afterDisplayPath}`
              : ''}
          </span>
        ))}
      </span>
    </button>
  );
}

function GitReviewFileBody(props: { controller: GitReviewController }) {
  const { controller } = props;
  if (controller.selectedFile === null) {
    return <GitReviewNotice>변경 파일을 선택해 주세요.</GitReviewNotice>;
  }
  if (controller.fileLoading) {
    return (
      <GitReviewNotice>파일 변경 내용을 불러오고 있습니다…</GitReviewNotice>
    );
  }
  if (controller.fileError !== null) {
    return (
      <GitReviewNotice
        actionLabel="다시 시도"
        onAction={controller.retrySelectedFile}
      >
        {controller.fileError}
      </GitReviewNotice>
    );
  }
  if (controller.fileIssue !== null) {
    return (
      <GitReviewNotice
        actionLabel="다시 불러오기"
        onAction={
          controller.fileIssue.kind === 'stale'
            ? controller.refresh
            : controller.retrySelectedFile
        }
      >
        {fileIssueLabel(controller.fileIssue)}
      </GitReviewNotice>
    );
  }
  if (controller.file === null) {
    return (
      <GitReviewNotice
        actionLabel="내용 불러오기"
        onAction={controller.retrySelectedFile}
      >
        저장소가 갱신되었습니다. 선택한 파일을 다시 불러와 주세요.
      </GitReviewNotice>
    );
  }

  const sections = new Map(
    controller.file.sections.map((section) => [section.sectionId, section]),
  );
  const renamedLayer = controller.selectedFile.layers.find(
    (layer) =>
      layer.state === 'renamed' &&
      layer.beforeDisplayPath !== null &&
      layer.afterDisplayPath !== null,
  );
  const emptyRowsMessage =
    renamedLayer === undefined
      ? controller.file.sections.some(
          (section) => section.projection !== 'text',
        )
        ? '내용 비교 대신 위 변경 정보를 표시합니다.'
        : controller.selectedFile.layers.some(
              (layer) => layer.state === 'untracked',
            )
          ? '빈 파일이 새로 추가되었습니다.'
          : '이 변경에는 표시할 텍스트 줄이 없습니다.'
      : `${renamedLayer.beforeDisplayPath}에서 ${renamedLayer.afterDisplayPath}(으)로 이름이 바뀌었고 내용은 그대로입니다.`;
  return (
    <>
      <div className="git-review-file-header">
        <strong>{controller.selectedFile.displayPath}</strong>
        <span>읽기 전용</span>
      </div>
      <GitReviewSectionNotices sections={controller.file.sections} />
      <div className="git-review-rows" role="table" aria-label="파일 변경 내용">
        {controller.file.rows.items.map((row, index) => (
          <GitReviewRow
            key={`${index}:${row.sectionId}:${row.kind}:${row.oldLine ?? ''}:${row.newLine ?? ''}`}
            row={row}
            section={sections.get(row.sectionId) ?? null}
          />
        ))}
        {controller.file.rows.items.length === 0 ? (
          <GitReviewNotice>{emptyRowsMessage}</GitReviewNotice>
        ) : null}
      </div>
      {controller.file.rows.nextCursor === null ? null : (
        <div className="git-review-row-more">
          <button
            type="button"
            className="git-review-action"
            disabled={controller.fileLoadingMore}
            onClick={controller.loadMoreFile}
          >
            {controller.fileLoadingMore ? '불러오는 중…' : '변경 줄 더 보기'}
          </button>
        </div>
      )}
    </>
  );
}

function GitReviewSectionNotices(props: {
  sections: GitReviewComparisonSection[];
}) {
  const exceptional = props.sections.filter(
    (section) => section.projection !== 'text',
  );
  if (exceptional.length === 0) {
    return null;
  }
  return (
    <div className="git-review-section-notices">
      {exceptional.map((section) => (
        <div key={section.sectionId}>
          <strong>{comparisonLabel(section.comparison)}</strong>
          <span>
            {section.projection === 'conflict'
              ? '병합 충돌이 있어 자동 텍스트 비교 대신 충돌 상태를 표시합니다.'
              : metadataReasonLabel(section.metadataReason)}
          </span>
        </div>
      ))}
    </div>
  );
}

function GitReviewRow(props: {
  row: GitReviewDiffRow;
  section: GitReviewComparisonSection | null;
}) {
  const { row, section } = props;
  const prefix =
    row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ' ';
  return (
    <div
      role="row"
      className={`git-review-row ${row.kind}`}
      aria-label={rowLabel(row, section)}
    >
      <span role="cell" className="git-review-line-number">
        {row.oldLine ?? ''}
      </span>
      <span role="cell" className="git-review-line-number">
        {row.newLine ?? ''}
      </span>
      <span role="cell" className="git-review-line-prefix" aria-hidden="true">
        {prefix}
      </span>
      <code role="cell">{row.content}</code>
    </div>
  );
}

function GitReviewNotice(props: {
  children: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="git-review-notice" role="status">
      <span>{props.children}</span>
      {props.actionLabel === undefined ||
      props.onAction === undefined ? null : (
        <button
          type="button"
          className="git-review-action"
          onClick={props.onAction}
        >
          {props.actionLabel}
        </button>
      )}
    </div>
  );
}

function branchLabel(summary: GitReviewController['changedSummary']): string {
  if (summary === null) {
    return 'Git 변경 사항';
  }
  return summary.branch.detached
    ? '분리된 HEAD'
    : (summary.branch.name ?? '초기 브랜치');
}

function formatTotalsOrFiles(
  totals: NonNullable<GitReviewController['changedSummary']>['totals'],
): string {
  return (
    formatTotals(totals) ??
    `${totals.fileCount.toLocaleString()}개 파일 · 줄 통계 일부 미제공`
  );
}

function formatTotals(
  totals: NonNullable<GitReviewController['changedSummary']>['totals'],
): string | null {
  if (
    !totals.lineStatsComplete ||
    totals.additions === null ||
    totals.deletions === null
  ) {
    return null;
  }
  return `+${totals.additions.toLocaleString()} −${totals.deletions.toLocaleString()}`;
}

function comparisonLabel(
  comparison: GitReviewFileSummary['layers'][number]['comparison'],
): string {
  switch (comparison) {
    case 'staged':
      return '스테이지됨';
    case 'unstaged':
      return '작업 트리';
    case 'untracked':
      return '추적 안 됨';
    case 'conflict':
      return '충돌';
  }
}

function stateLabel(
  state: GitReviewFileSummary['layers'][number]['state'],
): string {
  switch (state) {
    case 'added':
      return '추가';
    case 'modified':
      return '수정';
    case 'deleted':
      return '삭제';
    case 'renamed':
      return '이름 변경';
    case 'type_changed':
      return '형식 변경';
    case 'conflicted':
      return '병합 필요';
    case 'untracked':
      return '추적 안 됨';
  }
}

function fileIssueLabel(issue: NonNullable<GitReviewController['fileIssue']>) {
  if (issue.kind === 'stale') {
    return '검토 중 저장소가 변경되어 새 관찰이 필요합니다.';
  }
  switch (issue.reason) {
    case 'comparison_unsupported':
      return '이 파일의 변경은 안전한 텍스트 비교로 표시할 수 없습니다.';
    case 'resource_limit':
      return '이 파일은 현재 전송 경계 안에서 안전하게 불러올 수 없습니다.';
    case 'row_exceeds_transport_boundary':
      return '한 변경 줄이 전송 경계를 넘어 부분 결과를 표시하지 않았습니다.';
  }
}

function metadataReasonLabel(
  reason: Extract<
    GitReviewComparisonSection,
    { projection: 'metadata_only' }
  >['metadataReason'],
): string {
  switch (reason) {
    case 'binary':
      return '바이너리 파일이라 내용 대신 변경 메타데이터만 표시합니다.';
    case 'symlink':
      return '심볼릭 링크라 대상 내용을 따라가지 않고 메타데이터만 표시합니다.';
    case 'submodule':
      return 'Git 서브모듈 변경이라 객체 정보만 표시합니다.';
    case 'special_file':
      return '특수 파일이라 열지 않고 메타데이터만 표시합니다.';
    case 'filtered_content_unsupported':
      return '실행형 Git 필터가 필요한 내용은 실행하지 않고 메타데이터만 표시합니다.';
    case 'unsupported_content_transformation':
      return '지원하지 않는 내용 변환이 있어 메타데이터만 표시합니다.';
    case 'safe_read_unavailable':
      return '안전한 파일 읽기를 보장할 수 없어 메타데이터만 표시합니다.';
  }
}

function rowLabel(
  row: GitReviewDiffRow,
  section: GitReviewComparisonSection | null,
): string {
  const layer =
    section === null ? '' : `${comparisonLabel(section.comparison)} `;
  switch (row.kind) {
    case 'addition':
      return `${layer}추가 줄 ${row.newLine ?? ''}: ${row.content}`;
    case 'deletion':
      return `${layer}삭제 줄 ${row.oldLine ?? ''}: ${row.content}`;
    case 'hunk':
      return `${layer}변경 구간 ${row.content}`;
    case 'metadata':
      return `${layer}파일 정보 ${row.content}`;
    case 'context':
      return `${layer}문맥 줄 ${row.newLine ?? row.oldLine ?? ''}: ${row.content}`;
  }
}
