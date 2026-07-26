interface GoalStartCommand {
  objective: string;
}

export function readGoalStartCommand(prompt: string): GoalStartCommand | null {
  const match = /^\/goal\s+([\s\S]+)$/u.exec(prompt.trim());
  const objective = match?.[1]?.trim();
  return objective === undefined || objective.length === 0
    ? null
    : { objective };
}
