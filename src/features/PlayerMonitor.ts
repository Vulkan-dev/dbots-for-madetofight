import { Vector3D, MathUtils } from '../utils/MathUtils';
import { NotificationService } from '../notify/NotificationService';
import { IgnoreListStorage } from '../storage/IgnoreListStorage';
import { logger } from '../utils/logger';

export interface TrackedPlayer {
  runtimeEntityId: string | bigint | number;
  uuid: string;
  username: string;
  position: Vector3D;
  lastNotifiedPosition?: Vector3D;
  lastNotifiedTime?: number;
}

let _AccountManagerModule: any = null;
function getAccountManager() {
  if (!_AccountManagerModule) {
    try {
      _AccountManagerModule = require('../network/AccountManager').AccountManager;
    } catch {}
  }
  return _AccountManagerModule;
}

export class PlayerMonitor {
  private accountId: string;
  private radiusChunks: number;
  private thresholdBlocks: number;
  private notificationService: NotificationService;
  private trackedPlayers: Map<string, TrackedPlayer> = new Map();
  private isBotCheckCallback: ((name?: string, runtimeId?: any) => boolean) | null = null;

  // Rate-limiting state for throttled debug logging of unexpected/malformed packets
  private lastMissingIdLogTime: number = 0;
  private suppressedMissingIdCount: number = 0;
  private lastMalformedPosLogTime: number = 0;
  private suppressedMalformedPosCount: number = 0;

  constructor(
    accountId: string,
    radiusChunks: number,
    thresholdBlocks: number,
    notificationService: NotificationService
  ) {
    this.accountId = accountId;
    this.radiusChunks = radiusChunks;
    this.thresholdBlocks = thresholdBlocks;
    this.notificationService = notificationService;
  }

  public setBotCheckCallback(cb: (name?: string, runtimeId?: any) => boolean): void {
    this.isBotCheckCallback = cb;
  }

  private isFellowBot(username?: string, runtimeId?: any): boolean {
    if (this.isBotCheckCallback && this.isBotCheckCallback(username, runtimeId)) {
      return true;
    }
    const mgr = getAccountManager();
    if (mgr && typeof mgr.isKnownBot === 'function') {
      return mgr.isKnownBot(username, runtimeId);
    }
    return false;
  }

  public updateConfig(radiusChunks: number, thresholdBlocks: number): void {
    this.radiusChunks = radiusChunks;
    this.thresholdBlocks = thresholdBlocks;
  }

  private isValidVector3D(pos: any): pos is Vector3D {
    return (
      pos != null &&
      typeof pos.x === 'number' &&
      !isNaN(pos.x) &&
      typeof pos.y === 'number' &&
      !isNaN(pos.y) &&
      typeof pos.z === 'number' &&
      !isNaN(pos.z)
    );
  }

  /**
   * Called when a player entity is spawned or added to the client's entity list by the server.
   */
  public handlePlayerAdd(
    runtimeId: string | bigint | number | undefined | null,
    uuid: string,
    username: string,
    position: Vector3D,
    botPosition: Vector3D
  ): void {
    if (runtimeId == null) {
      logger.debug('[PlayerMonitor] Ignoring add_player packet: missing runtime/entity ID', this.accountId);
      return;
    }

    if (!this.isValidVector3D(position) || !this.isValidVector3D(botPosition)) {
      logger.debug('[PlayerMonitor] Ignoring add_player packet: malformed position data', this.accountId);
      return;
    }

    const key = String(runtimeId);

    if (!MathUtils.isWithinChunkRadius(botPosition, position, this.radiusChunks)) {
      return;
    }

    const distance = MathUtils.euclideanDistance(botPosition, position);
    const existing = this.trackedPlayers.get(key);

    if (!existing) {
      const player: TrackedPlayer = {
        runtimeEntityId: runtimeId,
        uuid: uuid || '',
        username: username || 'Unknown',
        position: { x: position.x, y: position.y, z: position.z },
        lastNotifiedPosition: { x: position.x, y: position.y, z: position.z },
        lastNotifiedTime: Date.now(),
      };
      this.trackedPlayers.set(key, player);

      // Check if fellow bot (ignoring each other)
      if (this.isFellowBot(player.username, runtimeId)) {
        logger.debug(`[PlayerMonitor] Suppressed alert for fellow bot: ${player.username} (${runtimeId})`, this.accountId);
        return;
      }

      // Check ignore list before dispatching notification
      if (IgnoreListStorage.isIgnored(player.username)) {
        logger.debug(`[PlayerMonitor] Suppressed alert for ignored player: ${player.username}`, this.accountId);
        return;
      }

      // Suppress alerts for unresolved placeholder names (e.g. Player_123 or Unknown)
      if (player.username.startsWith('Player_') || player.username === 'Unknown') {
        logger.debug(`[PlayerMonitor] Suppressed alert for unresolved entity: ${player.username}`, this.accountId);
        return;
      }

      if (this.notificationService) {
        this.notificationService.notifyPlayerDetected({
          name: player.username,
          position,
          distance,
          accountId: this.accountId,
        });
      }
    } else {
      existing.position.x = position.x;
      existing.position.y = position.y;
      existing.position.z = position.z;

      // If previously had a placeholder name, update with real username
      if (username && username !== 'Unknown' && (!existing.username || existing.username.startsWith('Player_') || existing.username === 'Unknown')) {
        existing.username = username;
        existing.uuid = uuid || existing.uuid;

        // If fellow bot or ignored, suppress
        if (this.isFellowBot(username, runtimeId) || IgnoreListStorage.isIgnored(username)) {
          return;
        }

        existing.lastNotifiedPosition = { x: position.x, y: position.y, z: position.z };
        existing.lastNotifiedTime = Date.now();
        if (this.notificationService) {
          this.notificationService.notifyPlayerDetected({
            name: username,
            position,
            distance,
            accountId: this.accountId,
          });
        }
      }
    }
  }

  /**
   * Called when a player entity moves.
   */
  public handlePlayerMove(
    runtimeId: string | bigint | number | undefined | null,
    newPosition: Vector3D,
    botPosition: Vector3D
  ): void {
    if (runtimeId == null) {
      const now = Date.now();
      this.suppressedMissingIdCount++;
      if (now - this.lastMissingIdLogTime >= 5000) {
        const suppressed =
          this.suppressedMissingIdCount > 1
            ? ` (suppressed ${this.suppressedMissingIdCount - 1} similar packets)`
            : '';
        logger.debug(
          `[PlayerMonitor] Ignoring movement packet: missing runtime/entity ID${suppressed}`,
          this.accountId
        );
        this.lastMissingIdLogTime = now;
        this.suppressedMissingIdCount = 0;
      }
      return;
    }

    if (!this.isValidVector3D(newPosition)) {
      const now = Date.now();
      this.suppressedMalformedPosCount++;
      if (now - this.lastMalformedPosLogTime >= 5000) {
        const suppressed =
          this.suppressedMalformedPosCount > 1
            ? ` (suppressed ${this.suppressedMalformedPosCount - 1} similar packets)`
            : '';
        logger.debug(
          `[PlayerMonitor] Ignoring movement packet: malformed position data${suppressed}`,
          this.accountId
        );
        this.lastMalformedPosLogTime = now;
        this.suppressedMalformedPosCount = 0;
      }
      return;
    }

    if (!this.isValidVector3D(botPosition)) {
      return;
    }

    const key = String(runtimeId);
    const player = this.trackedPlayers.get(key);

    if (!player) {
      if (MathUtils.isWithinChunkRadius(botPosition, newPosition, this.radiusChunks)) {
        // Track position silently without dispatching alert until add_player packet provides actual username
        const placeholderPlayer: TrackedPlayer = {
          runtimeEntityId: runtimeId,
          uuid: '',
          username: `Player_${key}`,
          position: { x: newPosition.x, y: newPosition.y, z: newPosition.z },
          lastNotifiedPosition: { x: newPosition.x, y: newPosition.y, z: newPosition.z },
          lastNotifiedTime: Date.now(),
        };
        this.trackedPlayers.set(key, placeholderPlayer);
      }
      return;
    }

    // Mutate coordinates in-place to avoid GC allocation on high-frequency movement packets
    player.position.x = newPosition.x;
    player.position.y = newPosition.y;
    player.position.z = newPosition.z;

    if (!MathUtils.isWithinChunkRadius(botPosition, newPosition, this.radiusChunks)) {
      // Player walked outside monitored chunk radius: remove from tracking so if they return they are notified again
      this.trackedPlayers.delete(key);
      logger.debug(`Player ${player.username} (${key}) walked out of monitored radius`, this.accountId);
      return;
    }

    const currentDist = MathUtils.euclideanDistance(botPosition, newPosition);
    const lastNotifiedDist = player.lastNotifiedPosition
      ? MathUtils.euclideanDistance(botPosition, player.lastNotifiedPosition)
      : Infinity;
    const now = Date.now();
    const timeSinceLastNotified = now - (player.lastNotifiedTime || 0);

    // Alert triggers:
    // 1. Player closed distance towards bot by >= thresholdBlocks (default 5 blocks, e.g. 20m -> 15m -> 10m -> 5m)
    // 2. High-threat proximity: Player is within danger range (<= 16 blocks) and >= 8 seconds since last alert
    // 3. Persistent presence: Player remains in chunk radius and >= 30 seconds since last alert
    const movedSignificantlyCloser = (lastNotifiedDist - currentDist) >= (this.thresholdBlocks || 5);
    const closeThreatRepeat = currentDist <= 16 && timeSinceLastNotified >= 8000;
    const periodicReminder = timeSinceLastNotified >= 30000;

    if (movedSignificantlyCloser || closeThreatRepeat || periodicReminder) {
      player.lastNotifiedPosition = { x: newPosition.x, y: newPosition.y, z: newPosition.z };
      player.lastNotifiedTime = now;

      // Skip fellow bots, ignored players, and unresolved placeholder names
      if (this.isFellowBot(player.username, runtimeId) ||
          IgnoreListStorage.isIgnored(player.username) ||
          player.username.startsWith('Player_') ||
          player.username === 'Unknown') {
        return;
      }

      if (this.notificationService) {
        this.notificationService.notifyPlayerDetected({
          name: player.username,
          position: newPosition,
          distance: currentDist,
          accountId: this.accountId,
        });
      }
    }
  }

  /**
   * Called when a player entity is removed by the server.
   */
  public handlePlayerRemove(runtimeId: string | bigint | number | undefined | null): void {
    if (runtimeId == null) {
      return;
    }
    const key = String(runtimeId);
    if (this.trackedPlayers.has(key)) {
      logger.debug(`Player entity ${key} removed from tracking range`, this.accountId);
      this.trackedPlayers.delete(key);
    }
  }

  /**
   * Returns current active tracked players list.
   */
  public getTrackedPlayers(): TrackedPlayer[] {
    return Array.from(this.trackedPlayers.values());
  }

  public clear(): void {
    this.trackedPlayers.clear();
  }
}
