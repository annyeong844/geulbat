export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchFilesResult {
  backend: string;
  query: string;
  total: number;
  truncated: boolean;
  results: SearchMatch[];
}

export type SearchPathMatcher = ((filePath: string) => boolean) | null;
