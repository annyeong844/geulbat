export type ToolCallSource =
  | { kind: 'agent_loop' }
  | {
      kind: 'ptc_callback';
      parentToolCallId: string;
      runtimeToolCallId: string;
      hostCallId: string;
      cellId?: string;
    };

export const AGENT_LOOP_TOOL_CALL_SOURCE: ToolCallSource = {
  kind: 'agent_loop',
};
