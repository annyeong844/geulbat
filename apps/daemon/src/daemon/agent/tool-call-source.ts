export type ToolCallSource =
  | { kind: 'agent_loop' }
  | {
      kind: 'ptc_callback';
      parentToolCallId: string;
      runtimeToolCallId: string;
      hostCallId: string;
      cellId?: string;
      // Audit field for nested writes: the resolved approval class is recorded
      // in the transcript alongside callId/parent callId/changed-files.
      approvalClass?: string;
    }
  | {
      kind: 'artifact_frame';
      scopeHandle: string;
      runtimeToolCallId: string;
      hostCallId: string;
      cellId?: string;
      // ptc_callback과 동일한 write 감사 필드 — 승인 클래스가 트랜스크립트에
      // 함께 남는다.
      approvalClass?: string;
    };

export const AGENT_LOOP_TOOL_CALL_SOURCE: ToolCallSource = {
  kind: 'agent_loop',
};
