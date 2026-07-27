export interface SearchMatch {
  path: string;
  line: number;
  /**
   * 매치된 줄의 미리보기. 생성된 index/minified 파일은 파일 전체가 한 줄이라
   * 원본 줄이 수 MB일 수 있으므로 미리보기 상한을 넘으면 잘린다. 권위 있는 내용은
   * `path`/`line`의 파일 자체이므로 read_file로 되돌아갈 수 있다.
   */
  text: string;
  /**
   * 자르기 전 원본 줄의 UTF-8 바이트 수. 매치된 줄이 있는 content 검색에만
   * 존재하고, filename 검색 결과에는 없다.
   */
  textBytes?: number;
  /** 미리보기가 잘렸을 때만 존재한다. */
  textTruncated?: true;
}

export interface SearchFilesResult {
  backend: string;
  consistency?: 'eventual_index' | 'filesystem_snapshot';
  acceleration?: {
    backend: 'windows-search-index';
    status: 'unavailable';
    reasonCode: string;
  };
  query: string;
  total: number;
  totalRelation?: 'exact' | 'lower_bound';
  truncated: boolean;
  results: SearchMatch[];
}

export type SearchPathMatcher = ((filePath: string) => boolean) | null;
