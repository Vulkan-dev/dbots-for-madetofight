import { logger } from '../utils/logger';

export class Watchdog {
  private accountId: string;
  private reconnectDelayMs: number;
  private isStopped: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCallback: (() => Promise<void>) | null = null;

  constructor(accountId: string, reconnectDelayMs: number = 6000) {
    this.accountId = accountId;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  public setReconnectCallback(callback: () => Promise<void>): void {
    this.reconnectCallback = callback;
  }

  /**
   * Resets stopped flag when connection starts.
   */
  public start(): void {
    this.isStopped = false;
  }

  /**
   * Called when a client disconnects, encounters an error, or gets kicked for ANY reason.
   * Dynamically extends delay if the server proxy reports a ghost session ("already online").
   */
  public handleDisconnect(reason?: string, minDelayMs?: number): void {
    if (this.isStopped) {
      logger.debug('Watchdog is stopped by user. Ignoring disconnect event.', this.accountId);
      return;
    }

    logger.warn(`Disconnect/kick detected. Reason: ${reason || 'Unknown disconnect reason'}`, this.accountId);

    // Detect proxy ghost sessions
    const normalizedReason = (reason || '').toLowerCase();
    const isGhostSession =
      normalizedReason.includes('already logged in') ||
      normalizedReason.includes('already online') ||
      normalizedReason.includes('already connected');

    let actualDelay = isGhostSession ? Math.max(this.reconnectDelayMs, 20000) : this.reconnectDelayMs;
    if (typeof minDelayMs === 'number') {
      actualDelay = Math.max(actualDelay, minDelayMs);
    }

    if (isGhostSession) {
      logger.warn(
        `Ghost session detected on server proxy ("${reason}"). Waiting ${actualDelay}ms for proxy session to clear...`,
        this.accountId
      );
    }

    // If a timer is already scheduled, don't duplicate unless ghost session requires extended wait
    if (this.reconnectTimer) {
      if (isGhostSession) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      } else {
        logger.debug('Watchdog already has a reconnect scheduled. Waiting for timer...', this.accountId);
        return;
      }
    }

    logger.info(`Watchdog scheduling reconnect attempt in ${actualDelay} ms...`, this.accountId);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isStopped) return;

      try {
        logger.info(`Watchdog executing reconnection attempt...`, this.accountId);
        if (this.reconnectCallback) {
          await this.reconnectCallback();
        }
      } catch (err) {
        logger.error(`Reconnection attempt encountered an error`, this.accountId, err);
        // Automatically schedule next retry if reconnectCallback throws
        this.handleDisconnect(err instanceof Error ? err.message : String(err));
      }
    }, actualDelay);
  }

  /**
   * Called on manual user disconnect to permanently stop Watchdog until next manual connect
   */
  public stop(): void {
    this.isStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    logger.info('Watchdog stopped (manual disconnect).', this.accountId);
  }

  public reset(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  public isRunning(): boolean {
    return !this.isStopped;
  }
}
