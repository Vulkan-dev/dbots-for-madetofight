import { logger } from '../utils/logger';
import { sanitizeErrorMessage } from '../utils/ErrorSanitizer';

export class Watchdog {
  private accountId: string;
  private reconnectDelayMs: number;
  private isStopped: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCallback: (() => Promise<void>) | null = null;

  // Progressive backoff tracking
  private consecutiveDisconnects: number = 0;
  private connectionStabilityTimer: NodeJS.Timeout | null = null;

  constructor(accountId: string, reconnectDelayMs: number = 6000) {
    this.accountId = accountId;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  public setReconnectCallback(callback: () => Promise<void>): void {
    this.reconnectCallback = callback;
  }

  /**
   * Called when bot successfully connects and joins the server.
   * If the connection remains stable for 60 seconds, resets the consecutive disconnect counter.
   */
  public onConnected(): void {
    if (this.connectionStabilityTimer) {
      clearTimeout(this.connectionStabilityTimer);
      this.connectionStabilityTimer = null;
    }

    this.connectionStabilityTimer = setTimeout(() => {
      this.connectionStabilityTimer = null;
      if (this.consecutiveDisconnects > 0) {
        logger.debug(`Bot connection remained stable for 60s. Resetting consecutive disconnect backoff.`, this.accountId);
        this.consecutiveDisconnects = 0;
      }
    }, 60000);
  }

  /**
   * Resets stopped flag when connection starts.
   */
  public start(): void {
    this.isStopped = false;
  }

  /**
   * Called when a client disconnects, encounters an error, or gets kicked for ANY reason.
   * Applies progressive backoff on consecutive disconnects to prevent proxy anti-bot kick loops.
   */
  public handleDisconnect(reason?: string, minDelayMs?: number): void {
    if (this.isStopped) {
      logger.debug('Watchdog is stopped by user. Ignoring disconnect event.', this.accountId);
      return;
    }

    if (this.connectionStabilityTimer) {
      clearTimeout(this.connectionStabilityTimer);
      this.connectionStabilityTimer = null;
    }

    this.consecutiveDisconnects++;

    logger.warn(
      `Disconnect/kick detected (attempt #${this.consecutiveDisconnects}). Reason: ${reason || 'Unknown disconnect reason'}`,
      this.accountId
    );

    // Detect proxy ghost sessions
    const normalizedReason = (reason || '').toLowerCase();
    const isGhostSession =
      normalizedReason.includes('already logged in') ||
      normalizedReason.includes('already online') ||
      normalizedReason.includes('already connected');

    // Progressive backoff calculation:
    // 1st disconnect: Math.max(reconnectDelayMs, 10s)
    // 2nd disconnect: 20s
    // 3rd disconnect: 35s
    // 4th+ disconnect: 60s
    let actualDelay: number;
    if (this.consecutiveDisconnects === 1) {
      actualDelay = Math.max(this.reconnectDelayMs, 10000);
    } else if (this.consecutiveDisconnects === 2) {
      actualDelay = 20000;
    } else if (this.consecutiveDisconnects === 3) {
      actualDelay = 35000;
    } else {
      actualDelay = 60000;
    }

    if (isGhostSession) {
      actualDelay = Math.max(actualDelay, 25000);
    }

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

    logger.info(`Watchdog scheduling reconnect attempt #${this.consecutiveDisconnects} in ${actualDelay} ms...`, this.accountId);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isStopped) return;

      try {
        logger.info(`Watchdog executing reconnection attempt #${this.consecutiveDisconnects}...`, this.accountId);
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
    if (this.connectionStabilityTimer) {
      clearTimeout(this.connectionStabilityTimer);
      this.connectionStabilityTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.consecutiveDisconnects = 0;
    logger.info('Watchdog stopped (manual disconnect).', this.accountId);
  }

  public reset(): void {
    if (this.connectionStabilityTimer) {
      clearTimeout(this.connectionStabilityTimer);
      this.connectionStabilityTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.consecutiveDisconnects = 0;
  }

  public isRunning(): boolean {
    return !this.isStopped;
  }
}
