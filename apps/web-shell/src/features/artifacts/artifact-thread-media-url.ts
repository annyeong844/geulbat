export function buildArtifactThreadMediaUrl(
  threadId: string,
  mediaRef: string,
): string {
  return `/api/threads/${encodeURIComponent(threadId)}/media/${encodeURIComponent(mediaRef)}`;
}
