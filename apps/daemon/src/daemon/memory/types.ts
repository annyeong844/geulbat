export interface MemoryManifestFile {
  path: string;
  sourceVersionToken: string;
  indexPath: string;
  chunkCount: number;
  updatedAt: string;
}

export interface MemoryManifest {
  version: 2;
  generationId: string;
  generatedAt: string;
  sourceDirectory: string;
  sourceIndexVersionToken: string;
  files: MemoryManifestFile[];
}

export interface MemoryChunkRecord {
  chunkId: string;
  path: string;
  sourceVersionToken: string;
  title: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  searchText: string;
}

export interface BuildMemoryIndexResult {
  generationId: string;
  generatedAt: string;
  fileCount: number;
  chunkCount: number;
  manifestPath: string;
  memoryPath: string;
}

export interface LoadedMemoryIndex {
  manifest: MemoryManifest;
  records: MemoryChunkRecord[];
}
