export interface SearchMatch {
  path: string;
  line: number;
  text: string;
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
  truncated: boolean;
  results: SearchMatch[];
}

export type SearchPathMatcher = ((filePath: string) => boolean) | null;
