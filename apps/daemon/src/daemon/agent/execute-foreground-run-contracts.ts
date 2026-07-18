export interface ExecuteForegroundRunDeps {
  appendTranscriptEntry?: typeof import('../sessions/transcript-log.js').appendTranscriptEntry;
  commitThreadArtifactVersion?: typeof import('../sessions/artifact-store.js').commitThreadArtifactVersion;
  commitThreadArtifactUpdateVersion?: typeof import('../sessions/artifact-store.js').commitThreadArtifactUpdateVersion;
  deleteThreadArtifact?: typeof import('../sessions/artifact-store.js').deleteThreadArtifact;
  deleteThreadArtifactUpdateVersion?: typeof import('../sessions/artifact-store.js').deleteThreadArtifactUpdateVersion;
  readTranscriptEntries?: typeof import('../sessions/transcript-log.js').readTranscriptEntries;
  replaceTranscriptEntries?: typeof import('../sessions/transcript-log.js').replaceTranscriptEntries;
  loadThreadIndex?: typeof import('../sessions/threads-index.js').loadThreadIndex;
  upsertThreadSummary?: typeof import('../sessions/threads-index.js').upsertThreadSummary;
  now?: () => string;
  onPostRunPersistenceError?: (phase: string, error: unknown) => void;
}

export type ResolvedExecuteForegroundRunDeps =
  Required<ExecuteForegroundRunDeps>;
