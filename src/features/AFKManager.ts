import { logger } from '../utils/logger';

export class AFKManager {
  private accountId: string;
  private enabled: boolean;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private actionCallback: (() => void) | null = null;

  constructor(accountId: string, enabled: boolean, intervalMs: number) {
    this.accountId = accountId;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
  }

  public setActionCallback(callback: () => void): void {
    this.actionCallback = callback;
  }

  public start(): void {
    this.stop();
    if (!this.enabled) {
      logger.debug('AFK Manager is disabled.', this.accountId);
      return;
    }

    logger.info(`Starting AFK presence ticker (Interval: ${this.intervalMs}ms)`, this.accountId);
    this.timer = setInterval(() => {
      this.performKeepAliveAction();
    }, this.intervalMs);
  }

  private performKeepAliveAction(): void {
    if (!this.enabled || !this.actionCallback) return;
    try {
      this.actionCallback();
    } catch (err) {
      logger.error('Error executing AFK activity action', this.accountId, err);
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public updateConfig(enabled: boolean, intervalMs: number): void {
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    if (this.timer) {
      this.start();
    }
  }
}
