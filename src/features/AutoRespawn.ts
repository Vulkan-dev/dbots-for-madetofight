import { logger } from '../utils/logger';

export class AutoRespawn {
  private botName: string;
  private respawnCallback: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isDead: boolean = false;
  private lastDeathTime: number = 0;

  private retryCount: number = 0;
  private readonly maxRetries: number = 3;

  constructor(botName: string) {
    this.botName = botName;
  }

  public setRespawnCallback(callback: () => void): void {
    this.respawnCallback = callback;
  }

  /**
   * Called when player death event is detected.
   * Debounces multiple simultaneous death signals (set_health, death_info, actor_event).
   * Immediately sends respawn packets and schedules retries if the server is slow to acknowledge.
   */
  public handleDeath(reason?: string): void {
    const now = Date.now();
    if (this.isDead && (now - this.lastDeathTime < 2500)) {
      logger.debug(`Duplicate death signal suppressed (${reason || 'unspecified'}).`, this.botName);
      return;
    }

    this.isDead = true;
    this.lastDeathTime = now;
    this.retryCount = 0;
    logger.info(`Bot death detected (${reason || 'unspecified'}). Auto-respawning immediately...`, this.botName);

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Immediately trigger respawn callback without waiting
    if (this.respawnCallback) {
      try { this.respawnCallback(); } catch (err) { logger.debug(`Respawn callback error: ${err}`, this.botName); }
    }

    // Schedule retries in case the server dropped the initial packet or lagged
    this.timer = setInterval(() => {
      if (!this.isDead) {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        return;
      }

      this.retryCount++;
      if (this.retryCount <= this.maxRetries) {
        logger.warn(`Respawn retry #${this.retryCount}/${this.maxRetries} dispatched...`, this.botName);
        if (this.respawnCallback) {
          try { this.respawnCallback(); } catch (err) { logger.debug(`Respawn retry error: ${err}`, this.botName); }
        }
      } else {
        logger.debug('Respawn retry limit reached. Waiting for server packet.', this.botName);
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
      }
    }, 2500);
  }

  public reset(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isDead = false;
    this.retryCount = 0;
  }

  public cancel(): void {
    this.reset();
  }

  public getIsDead(): boolean {
    return this.isDead;
  }
}
