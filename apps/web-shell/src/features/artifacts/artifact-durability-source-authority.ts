import type { ArtifactRunId } from '@geulbat/protocol/artifacts';
import type { ThreadId } from '@geulbat/protocol/ids';

export interface ArtifactDurabilitySourceAuthority {
  workingDirectory: string;
  threadId: ThreadId;
  runId: ArtifactRunId;
  messageTimestamp: string;
  filePath: string | null;
}
