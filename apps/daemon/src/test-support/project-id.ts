import type { ProjectId } from '@geulbat/protocol/ids';

export function testProjectId(value = 'workspace'): ProjectId {
  return value as ProjectId;
}
