type LoggerMethod = 'log' | 'warn' | 'error';
type LoggerLevel = 'info' | 'warn' | 'error';
type LoggerContextValue = string | number | boolean | null | undefined;

export type LoggerContext = Record<string, LoggerContextValue>;

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  withContext(context: LoggerContext): Logger;
}

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

function formatContextValue(
  value: Exclude<LoggerContextValue, undefined>,
): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function formatContext(context: LoggerContext): string {
  const entries = Object.entries(context)
    .filter(
      (entry): entry is [string, Exclude<LoggerContextValue, undefined>] => {
        const [, value] = entry;
        return value !== undefined;
      },
    )
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return '';
  }
  return entries
    .map(([key, value]) => `${key}=${formatContextValue(value)}`)
    .join(' ');
}

function writeLog(
  method: LoggerMethod,
  level: LoggerLevel,
  scope: string,
  context: LoggerContext,
  message: string,
  ...args: unknown[]
): void {
  const formattedContext = formatContext(context);
  const line = `${new Date().toISOString()} ${level} [${scope}] ${message}${
    formattedContext ? ` ${formattedContext}` : ''
  }`;
  console[method](line, ...args);
}

export function createLogger(
  scope: string,
  context: LoggerContext = {},
): Logger {
  return {
    info(message: string, ...args: unknown[]): void {
      writeLog('log', 'info', scope, context, message, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      writeLog('warn', 'warn', scope, context, message, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      writeLog('error', 'error', scope, context, message, ...args);
    },
    withContext(nextContext: LoggerContext): Logger {
      return createLogger(scope, {
        ...context,
        ...nextContext,
      });
    },
  };
}
