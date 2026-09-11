import { logger } from '../utils/logger';

export class AutoRespawn {
  private botName: string;
  private respawnCallback: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isDead: boolean = false;
  private lastDeathTime: number = 0;

  constructor(botName: string) {
    this.botName = botName;
  }

  public setRespawnCallback(callback: () => void): void {
    this.respawnCallback = callback;
  }

  /**
   * Called when player death event is detected.
   * Debounces multiple simultaneous death signals (set_health, death_info, actor_event).
   * Instantaneous auto-respawn (0ms) immediately sends respawn packets to eliminate death screen delay.
   */
  public handleDeath(reason?: string): void {
    const now = Date.now();
    if (this.isDead || (now - this.lastDeathTime < 1500)) {
      logger.debug(`Duplicate death signal suppressed (${reason || 'unspecified'}).`, this.botName);
      return;
    }

    this.isDead = true;
    this.lastDeathTime = now;
    logger.info(`Bot death detected (${reason || 'unspecified'}). Auto-respawning immediately (fastest possible)...`, this.botName);

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Immediately trigger respawn callback without waiting
    if (this.respawnCallback) {
      this.respawnCallback();
    }
  }

  public reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.isDead = false;
  }

  public cancel(): void {
    this.reset();
  }

  public getIsDead(): boolean {
    return this.isDead;
  }
}
