import { EventEmitter } from 'events';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogEntry {
  timestamp: string;
  level: string;
  tag: string;
  message: string;
  raw: string;
}

const MAX_BUFFER = 500;

class Logger extends EventEmitter {
  private level: LogLevel = LogLevel.INFO;
  private buffer: LogEntry[] = [];

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public getBuffer(): LogEntry[] {
    return this.buffer;
  }

  private push(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
    }
    this.emit('log', entry);
  }

  private formatMessage(levelStr: string, accountId: string | undefined, message: string): string {
    const timestamp = new Date().toISOString();
    const tag = accountId ? `[${accountId}]` : '[SYSTEM]';
    return `[${timestamp}] [${levelStr}] ${tag} ${message}`;
  }

  public debug(message: string, accountId?: string): void {
    if (this.level <= LogLevel.DEBUG) {
      const raw = this.formatMessage('DEBUG', accountId, message);
      console.log(raw);
      this.push({ timestamp: new Date().toISOString(), level: 'DEBUG', tag: accountId || 'SYSTEM', message, raw });
    }
  }

  public info(message: string, accountId?: string): void {
    if (this.level <= LogLevel.INFO) {
      const raw = this.formatMessage('INFO ', accountId, message);
      console.log(raw);
      this.push({ timestamp: new Date().toISOString(), level: 'INFO', tag: accountId || 'SYSTEM', message, raw });
    }
  }

  public warn(message: string, accountId?: string): void {
    if (this.level <= LogLevel.WARN) {
      const raw = this.formatMessage('WARN ', accountId, message);
      console.warn(raw);
      this.push({ timestamp: new Date().toISOString(), level: 'WARN', tag: accountId || 'SYSTEM', message, raw });
    }
  }

  public error(message: string, accountId?: string, error?: unknown): void {
    if (this.level <= LogLevel.ERROR) {
      const errStr = error instanceof Error ? ` | Exception: ${error.message}` : '';
      const raw = this.formatMessage('ERROR', accountId, message + errStr);
      console.error(raw);
      this.push({ timestamp: new Date().toISOString(), level: 'ERROR', tag: accountId || 'SYSTEM', message: message + errStr, raw });
      if (error instanceof Error && error.stack && this.level === LogLevel.DEBUG) {
        console.error(error.stack);
      }
    }
  }
}

export const logger = new Logger();
