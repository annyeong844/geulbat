import { EventEmitter } from 'node:events';

function emitProviderEvents(socket, events) {
  for (const event of events) {
    socket.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

function createRunSettlementProviderScenario({
  finalSuffix,
  prompt,
  streamPrefix,
}) {
  const finalText = `${streamPrefix}${finalSuffix}`;
  let emittedEventCount = 0;
  let emittedTextDeltaCount = 0;
  let pendingSocket;
  let requestCount = 0;

  const emitRunSettlementEvents = (socket, events) => {
    emittedEventCount += events.length;
    emittedTextDeltaCount += events.filter(
      (event) => event.type === 'response.output_text.delta',
    ).length;
    emitProviderEvents(socket, events);
  };

  return {
    matches(serializedRequest) {
      return serializedRequest.includes(prompt);
    },
    dispatch(socket) {
      if (pendingSocket !== undefined) {
        throw new Error(
          'flow-gate provider received a concurrent run-settlement request',
        );
      }
      if (requestCount !== 0) {
        throw new Error(
          'flow-gate provider received a duplicate run-settlement request',
        );
      }
      requestCount += 1;
      pendingSocket = socket;
      setImmediate(() => {
        if (pendingSocket !== socket) {
          return;
        }
        emitRunSettlementEvents(socket, [
          {
            type: 'response.output_item.added',
            item: {
              id: 'flow-gate-final-answer',
              type: 'message',
              phase: 'final_answer',
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'flow-gate-final-answer',
            delta: streamPrefix,
          },
        ]);
      });
    },
    complete() {
      if (pendingSocket === undefined) {
        throw new Error(
          'flow-gate provider has no run-settlement response to complete',
        );
      }
      const socket = pendingSocket;
      pendingSocket = undefined;
      emitRunSettlementEvents(socket, [
        {
          type: 'response.output_text.delta',
          item_id: 'flow-gate-final-answer',
          delta: finalSuffix,
        },
        {
          type: 'response.output_item.done',
          item: {
            id: 'flow-gate-final-answer',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: finalText }],
          },
        },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ]);
    },
    readRequestCount() {
      return requestCount;
    },
    readEventCounts() {
      return {
        eventCount: emittedEventCount,
        textDeltaCount: emittedTextDeltaCount,
      };
    },
  };
}

function createApprovalProviderScenario({
  content,
  finalText,
  prompt,
  targetPath,
}) {
  let finalRequestCount = 0;
  let toolCallRequestCount = 0;
  let requestCount = 0;

  return {
    matches(serializedRequest) {
      return (
        serializedRequest.includes(prompt) ||
        serializedRequest.includes('flow-gate-approval-call')
      );
    },
    dispatch(socket, serializedRequest) {
      const isFinalRound =
        serializedRequest.includes('"type":"function_call_output"') &&
        serializedRequest.includes('flow-gate-approval-call');
      if (isFinalRound ? finalRequestCount !== 0 : toolCallRequestCount !== 0) {
        throw new Error(
          `flow-gate provider received a duplicate approval ${
            isFinalRound ? 'final' : 'tool-call'
          } request`,
        );
      }
      if (isFinalRound) {
        finalRequestCount += 1;
      } else {
        toolCallRequestCount += 1;
      }
      requestCount += 1;
      let events;
      if (!isFinalRound) {
        events = [
          {
            type: 'response.output_item.done',
            item: {
              id: 'flow-gate-approval-function-call',
              type: 'function_call',
              call_id: 'flow-gate-approval-call',
              name: 'write_file',
              arguments: JSON.stringify({
                path: targetPath,
                content,
              }),
            },
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ];
      } else {
        events = [
          {
            type: 'response.output_item.added',
            item: {
              id: 'flow-gate-approval-final-answer',
              type: 'message',
              phase: 'final_answer',
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'flow-gate-approval-final-answer',
            delta: finalText,
          },
          {
            type: 'response.output_item.done',
            item: {
              id: 'flow-gate-approval-final-answer',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: finalText }],
            },
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 2,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ];
      }
      setImmediate(() => emitProviderEvents(socket, events));
    },
    readRequestCount() {
      return requestCount;
    },
  };
}

function createArtifactProviderScenario({ finalText, prompt }) {
  let requestCount = 0;

  return {
    matches(serializedRequest) {
      return serializedRequest.includes(prompt);
    },
    dispatch(socket) {
      if (requestCount !== 0) {
        throw new Error(
          'flow-gate provider received a duplicate artifact request',
        );
      }
      requestCount += 1;
      setImmediate(() => {
        emitProviderEvents(socket, [
          {
            type: 'response.output_item.added',
            item: {
              id: 'flow-gate-artifact-final-answer',
              type: 'message',
              phase: 'final_answer',
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'flow-gate-artifact-final-answer',
            delta: finalText,
          },
          {
            type: 'response.output_item.done',
            item: {
              id: 'flow-gate-artifact-final-answer',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: finalText }],
            },
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 1,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ]);
      });
    },
    readRequestCount() {
      return requestCount;
    },
  };
}

function createSubagentProviderScenario({
  childTask,
  finalText,
  parentPrompt,
}) {
  let parentRequestCount = 0;
  let childRequestCount = 0;

  return {
    matches(serializedRequest) {
      return (
        serializedRequest.includes(parentPrompt) ||
        serializedRequest.includes(childTask) ||
        serializedRequest.includes('flow-gate-subagent-spawn-call')
      );
    },
    dispatch(socket, serializedRequest) {
      if (!serializedRequest.includes(parentPrompt)) {
        if (!serializedRequest.includes(childTask) || childRequestCount !== 0) {
          throw new Error(
            'flow-gate provider received an invalid child-agent request',
          );
        }
        childRequestCount += 1;
        return;
      }

      parentRequestCount += 1;
      let events;
      if (parentRequestCount === 1) {
        events = [
          {
            type: 'response.output_item.done',
            item: {
              id: 'flow-gate-subagent-spawn-function-call',
              type: 'function_call',
              call_id: 'flow-gate-subagent-spawn-call',
              name: 'agent_spawn',
              arguments: JSON.stringify({
                task: childTask,
                subagent_type: 'explorer',
              }),
            },
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ];
      } else if (parentRequestCount === 2) {
        events = [
          {
            type: 'response.output_item.added',
            item: {
              id: 'flow-gate-subagent-final-answer',
              type: 'message',
              phase: 'final_answer',
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'flow-gate-subagent-final-answer',
            delta: finalText,
          },
          {
            type: 'response.output_item.done',
            item: {
              id: 'flow-gate-subagent-final-answer',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: finalText }],
            },
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 2,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ];
      } else {
        throw new Error(
          'flow-gate provider received an extra subagent parent request',
        );
      }
      setImmediate(() => emitProviderEvents(socket, events));
    },
    readState() {
      return { parentRequestCount, childRequestCount };
    },
  };
}

export function createDeterministicProviderRuntime(
  createResponsesWebSocketSessionStore,
  {
    artifactFinalText,
    artifactPrompt,
    approvalContent,
    approvalFinalText,
    approvalPrompt,
    approvalTargetPath,
    runFinalSuffix,
    runSettlementPrompt,
    runStreamPrefix,
    subagentChildTask,
    subagentFinalText,
    subagentParentPrompt,
  },
) {
  const runSettlement = createRunSettlementProviderScenario({
    finalSuffix: runFinalSuffix,
    prompt: runSettlementPrompt,
    streamPrefix: runStreamPrefix,
  });
  const approval = createApprovalProviderScenario({
    content: approvalContent,
    finalText: approvalFinalText,
    prompt: approvalPrompt,
    targetPath: approvalTargetPath,
  });
  const artifact = createArtifactProviderScenario({
    finalText: artifactFinalText,
    prompt: artifactPrompt,
  });
  const subagent = createSubagentProviderScenario({
    childTask: subagentChildTask,
    finalText: subagentFinalText,
    parentPrompt: subagentParentPrompt,
  });
  const webSocketSessions = createResponsesWebSocketSessionStore({
    async connectWebSocket() {
      const socket = new EventEmitter();
      socket.readyState = 1;
      socket.send = (payload) => {
        const request = JSON.parse(payload.toString());
        if (
          typeof request !== 'object' ||
          request === null ||
          request.type !== 'response.create'
        ) {
          throw new Error(
            'flow-gate provider received a non-Responses request',
          );
        }

        const serializedRequest = JSON.stringify(request);
        if (runSettlement.matches(serializedRequest)) {
          runSettlement.dispatch(socket);
          return;
        }
        if (approval.matches(serializedRequest)) {
          approval.dispatch(socket, serializedRequest);
          return;
        }
        if (artifact.matches(serializedRequest)) {
          artifact.dispatch(socket);
          return;
        }
        if (subagent.matches(serializedRequest)) {
          subagent.dispatch(socket, serializedRequest);
          return;
        }
        throw new Error('flow-gate provider received an unknown scenario');
      };
      socket.close = () => {
        socket.readyState = 3;
      };
      return socket;
    },
  });

  return {
    webSocketSessions,
    completeRunSettlement: runSettlement.complete,
    readRunSettlementRequestCount: runSettlement.readRequestCount,
    readRunSettlementEventCounts: runSettlement.readEventCounts,
    readApprovalRequestCount: approval.readRequestCount,
    readArtifactRequestCount: artifact.readRequestCount,
    readSubagentState: subagent.readState,
  };
}
