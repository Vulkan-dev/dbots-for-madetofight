export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel = LogLevel.INFO;

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  private formatMessage(levelStr: string, accountId: string | undefined, message: string): string {
    const timestamp = new Date().toISOString();
    const tag = accountId ? `[${accountId}]` : '[SYSTEM]';
    return `[${timestamp}] [${levelStr}] ${tag} ${message}`;
  }

  public debug(message: string, accountId?: string): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log(this.formatMessage('DEBUG', accountId, message));
    }
  }

  public info(message: string, accountId?: string): void {
    if (this.level <= LogLevel.INFO) {
      console.log(this.formatMessage('INFO ', accountId, message));
    }
  }

  public warn(message: string, accountId?: string): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.formatMessage('WARN ', accountId, message));
    }
  }

  public error(message: string, accountId?: string, error?: unknown): void {
    if (this.level <= LogLevel.ERROR) {
      const errStr = error instanceof Error ? ` | Exception: ${error.message}` : '';
      console.error(this.formatMessage('ERROR', accountId, message + errStr));
      if (error instanceof Error && error.stack && this.level === LogLevel.DEBUG) {
        console.error(error.stack);
      }
    }
  }
}

export const logger = new Logger();
