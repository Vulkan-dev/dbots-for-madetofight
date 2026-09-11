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

export class PlayerMonitor {
  private accountId: string;
  private radiusChunks: number;
  private thresholdBlocks: number;
  private notificationService: NotificationService;
  private trackedPlayers: Map<string, TrackedPlayer> = new Map();

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

      // Check ignore list before dispatching notification
      if (IgnoreListStorage.isIgnored(player.username)) {
        logger.debug(`[PlayerMonitor] Suppressed alert for ignored player: ${player.username}`, this.accountId);
        return;
      }

      this.notificationService.notifyPlayerDetected({
        name: player.username,
        position,
        distance,
        accountId: this.accountId,
      });
    } else {
      existing.position.x = position.x;
      existing.position.y = position.y;
      existing.position.z = position.z;
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

    if (!player) return;

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

    // Keep distance and position updated in real-time for combat/chest monitoring without spamming notifications
    if (player.lastNotifiedPosition) {
      player.lastNotifiedPosition.x = newPosition.x;
      player.lastNotifiedPosition.y = newPosition.y;
      player.lastNotifiedPosition.z = newPosition.z;
    } else {
      player.lastNotifiedPosition = { x: newPosition.x, y: newPosition.y, z: newPosition.z };
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
