import { logger } from '../utils/logger';

export class PlayerHitResponse {
  private accountId: string;
  private enabled: boolean;
  private crouchCount: number;
  private cooldownMs: number;
  private lastTriggered: number = 0;
  private crouchCallback: ((isSneaking: boolean, isCompleted?: boolean) => void) | null = null;
  private lookCallback: ((deltaPitch: number, deltaYaw: number) => void) | null = null;

  constructor(
    accountId: string,
    enabled: boolean,
    crouchCount: number = 2,
    cooldownMs: number = 3000
  ) {
    this.accountId = accountId;
    this.enabled = enabled;
    this.crouchCount = crouchCount;
    this.cooldownMs = cooldownMs;
  }

  public setCrouchCallback(callback: (isSneaking: boolean, isCompleted?: boolean) => void): void {
    this.crouchCallback = callback;
  }

  public setLookCallback(callback: (deltaPitch: number, deltaYaw: number) => void): void {
    this.lookCallback = callback;
  }

  /**
   * Triggers non-aggressive look with randomized rotation and crouch response when hit by a player.
   */
  public handlePlayerHit(): void {
    if (!this.enabled) {
      logger.debug('Player hit response feature is disabled.', this.accountId);
      return;
    }

    const now = Date.now();
    if (now - this.lastTriggered < this.cooldownMs) {
      logger.debug('Player hit response is on cooldown.', this.accountId);
      return;
    }

    this.lastTriggered = now;
    logger.info(`Received hit from player! Performing randomized look rotation and ${this.crouchCount}x crouch response.`, this.accountId);

    this.executeResponseSequence();
  }

  private async executeResponseSequence(): Promise<void> {
    // 1. Look with randomized rotation movement
    if (this.lookCallback) {
      const randomDeltaYaw = (Math.random() - 0.5) * 140; // -70 to +70 deg random yaw
      const randomDeltaPitch = (Math.random() - 0.5) * 30; // -15 to +15 deg random pitch
      this.lookCallback(randomDeltaPitch, randomDeltaYaw);
      await this.delay(150);
    }
    // Crouch pulses removed: Bot crouch state is strictly user-controlled and never modified automatically
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public updateConfig(enabled: boolean, crouchCount: number, cooldownMs: number): void {
    this.enabled = enabled;
    this.crouchCount = crouchCount;
    this.cooldownMs = cooldownMs;
  }
}
