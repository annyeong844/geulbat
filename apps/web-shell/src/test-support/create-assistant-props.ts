import type { AssistantProps } from '../features/assistant/Assistant.js';

type RequiredAssistantProjectionKey =
  | 'activity'
  | 'artifacts'
  | 'conversation'
  | 'runActions'
  | 'runState';

type AssistantPropsOverrides = Omit<
  Partial<AssistantProps>,
  RequiredAssistantProjectionKey
> & {
  activity?: Partial<AssistantProps['activity']>;
  artifacts?: Partial<AssistantProps['artifacts']>;
  conversation?: Partial<AssistantProps['conversation']>;
  runActions?: Partial<AssistantProps['runActions']>;
  runState?: Partial<AssistantProps['runState']>;
};

export function createAssistantProps(
  overrides: AssistantPropsOverrides = {},
): AssistantProps {
  const {
    activity,
    artifacts,
    conversation,
    runActions,
    runState,
    ...optionalProps
  } = overrides;

  return {
    conversation: {
      messages: [],
      transcriptEntries: [],
      finalAnswerText: '',
      ...conversation,
    },
    activity: {
      backgroundNotifications: [],
      ...activity,
    },
    artifacts: {
      onStartRun: () => {},
      ...artifacts,
    },
    runState: {
      streamError: null,
      isRunning: false,
      ...runState,
    },
    runActions: {
      onSend: () => {},
      onCancel: () => {},
      ...runActions,
    },
    ...optionalProps,
  };
}
