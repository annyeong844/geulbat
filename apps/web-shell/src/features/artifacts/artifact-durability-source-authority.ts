import type { ArtifactRunId } from '@geulbat/protocol/artifacts';
import type { ProjectId, ThreadId } from '@geulbat/protocol/ids';

export interface ArtifactDurabilitySourceAuthority {
  projectId: ProjectId;
  threadId: ThreadId;
  runId: ArtifactRunId;
  messageTimestamp: string;
  filePath: string | null;
}
