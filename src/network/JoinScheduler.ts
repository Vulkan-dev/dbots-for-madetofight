import { logger } from '../utils/logger';

export type JoinTask = () => Promise<void>;

export class JoinScheduler {
  private minDelayMs: number;
  private maxDelayMs: number;
  private queue: { accountId: string; task: JoinTask }[] = [];
  private activeJoins: Set<string> = new Set();
  private isProcessing: boolean = false;

  constructor(minDelayMs: number = 6000, maxDelayMs: number = 9000) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  public updateDelays(minDelayMs: number, maxDelayMs: number): void {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  /**
   * Generates a random delay integer between minDelayMs and maxDelayMs (inclusive).
   */
  public getRandomDelay(): number {
    const min = Math.min(this.minDelayMs, this.maxDelayMs);
    const max = Math.max(this.minDelayMs, this.maxDelayMs);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Schedules a connection attempt for an account.
   * Prevents duplicate simultaneous join attempts for the same account.
   */
  public scheduleJoin(accountId: string, task: JoinTask): boolean {
    if (this.activeJoins.has(accountId) || this.queue.some((item) => item.accountId === accountId)) {
      logger.warn(`Join attempt for account '${accountId}' is already queued or in progress. Skipping duplicate.`, accountId);
      return false;
    }

    this.queue.push({ accountId, task });
    logger.info(`Scheduled join for '${accountId}'. Current queue position: ${this.queue.length}`, accountId);

    if (!this.isProcessing) {
      this.processQueue();
    }
    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();

    if (item) {
      const { accountId, task } = item;
      this.activeJoins.add(accountId);

      try {
        logger.info(`Starting controlled connection process for '${accountId}'...`, accountId);
        await task();
      } catch (err) {
        logger.error(`Error executing scheduled join for '${accountId}'`, accountId, err);
      } finally {
        this.activeJoins.delete(accountId);
      }

      // If more accounts remain in queue, wait a randomized delay before starting the next connection
      if (this.queue.length > 0) {
        const delay = this.getRandomDelay();
        logger.info(`Controlled join scheduler: Waiting ${delay} ms (Randomized ${this.minDelayMs}–${this.maxDelayMs} ms) before connecting next account...`);
        await this.delay(delay);
      }
    }

    // Process next item in queue
    await this.processQueue();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public isAccountPending(accountId: string): boolean {
    return this.activeJoins.has(accountId) || this.queue.some((i) => i.accountId === accountId);
  }

  public cancelJoin(accountId: string): void {
    this.queue = this.queue.filter((item) => item.accountId !== accountId);
    this.activeJoins.delete(accountId);
  }
}
