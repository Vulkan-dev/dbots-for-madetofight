import { Vector3D, MathUtils } from '../utils/MathUtils';
import { NotificationService } from '../notify/NotificationService';
import { logger } from '../utils/logger';

export interface HostileTarget {
  runtimeEntityId: string | bigint;
  name: string;
  position: Vector3D;
  lastSeen: number;
}

export class DefensiveCombat {
  private accountId: string;
  private enabled: boolean;
  private allowedMobs: Set<string>;
  private mobBlacklist: Set<string>;
  private combatRange: number;
  private notificationService: NotificationService;
  private currentTarget: HostileTarget | null = null;
  private attackCallback: ((runtimeId: string | bigint) => void) | null = null;

  constructor(
    accountId: string,
    enabled: boolean,
    allowedMobs: string[],
    mobBlacklist: string[],
    combatRange: number,
    notificationService: NotificationService
  ) {
    this.accountId = accountId;
    this.enabled = enabled;
    this.allowedMobs = new Set(allowedMobs.map((m) => m.toLowerCase()));
    this.mobBlacklist = new Set(mobBlacklist.map((m) => m.toLowerCase()));
    this.combatRange = combatRange;
    this.notificationService = notificationService;
  }

  public setAttackCallback(callback: (runtimeId: string | bigint) => void): void {
    this.attackCallback = callback;
  }

  /**
   * Called when an entity attacks or damages the bot.
   */
  public handleEntityAttack(
    attackerRuntimeId: string | bigint,
    mobType: string,
    position: Vector3D,
    botPosition: Vector3D,
    isPlayer: boolean
  ): void {
    if (!this.enabled) {
      logger.debug('Defensive combat is disabled', this.accountId);
      return;
    }

    // Explicit check: NEVER attack players under any circumstance!
    if (isPlayer) {
      logger.debug('Attacker is a player entity. Defensive combat strictly ignores players.', this.accountId);
      return;
    }

    const normalizedMobName = mobType.toLowerCase().replace('minecraft:', '');

    // Check blacklist first
    if (this.mobBlacklist.has(normalizedMobName)) {
      logger.warn(`Ignoring blacklisted target '${normalizedMobName}'. Combat aborted for safety.`, this.accountId);
      this.clearTarget();
      return;
    }

    // Check whitelist / safe mob list
    if (!this.allowedMobs.has(normalizedMobName)) {
      logger.info(`Mob '${normalizedMobName}' is not in allowed target list. Doing nothing.`, this.accountId);
      return;
    }

    const distance = MathUtils.euclideanDistance(botPosition, position);
    if (distance > this.combatRange) {
      logger.debug(`Attacking mob '${normalizedMobName}' is out of combat range (${distance.toFixed(1)}m > ${this.combatRange}m).`, this.accountId);
      return;
    }

    // Set new target and notify
    this.currentTarget = {
      runtimeEntityId: attackerRuntimeId,
      name: normalizedMobName,
      position,
      lastSeen: Date.now(),
    };

    this.notificationService.notifyDefensiveAction({
      target: normalizedMobName,
      position,
      accountId: this.accountId,
    });

    this.executeDefenseSwing();
  }

  /**
   * Execute defensive attack swing if target is valid.
   */
  public executeDefenseSwing(): void {
    if (!this.currentTarget || !this.attackCallback) return;

    if (Date.now() - this.currentTarget.lastSeen > 5000) {
      logger.info(`Combat target timed out. Stopping engagement.`, this.accountId);
      this.clearTarget();
      return;
    }

    this.attackCallback(this.currentTarget.runtimeEntityId);
  }

  public handleEntityDeath(runtimeId: string | bigint | number | undefined | null): void {
    if (runtimeId == null) return;
    if (this.currentTarget && String(this.currentTarget.runtimeEntityId) === String(runtimeId)) {
      logger.info(`Combat target ${this.currentTarget.name} was defeated. Disengaging.`, this.accountId);
      this.clearTarget();
    }
  }

  public clearTarget(): void {
    this.currentTarget = null;
  }
}
