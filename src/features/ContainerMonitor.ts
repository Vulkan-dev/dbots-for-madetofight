import { Vector3D, MathUtils } from '../utils/MathUtils';
import { NotificationService } from '../notify/NotificationService';
import { IgnoreListStorage } from '../storage/IgnoreListStorage';
import { logger } from '../utils/logger';

export interface ContainerEventData {
  windowId?: number;
  containerType: string;
  position: Vector3D;
  player: string;
}

export class ContainerMonitor {
  private accountId: string;
  private radiusChunks: number;
  private notificationService: NotificationService;
  private recentEvents: Map<string, number> = new Map(); // Debounce key -> timestamp

  constructor(
    accountId: string,
    radiusChunks: number,
    notificationService: NotificationService
  ) {
    this.accountId = accountId;
    this.radiusChunks = radiusChunks;
    this.notificationService = notificationService;
  }

  /**
   * Processes container interaction events received from Bedrock protocol client packets
   * (such as container_open, inventory_transaction, or block_event).
   */
  public async handleContainerInteraction(
    botPosition: Vector3D,
    containerType: string,
    position: Vector3D,
    player: string = 'Unknown Player',
    playerPos?: Vector3D
  ): Promise<void> {
    if (!MathUtils.isWithinChunkRadius(botPosition, position, this.radiusChunks)) {
      return;
    }

    const eventKey = `${containerType}_${position.x}_${position.y}_${position.z}_${player}`;
    const now = Date.now();
    const lastTriggered = this.recentEvents.get(eventKey) || 0;

    // Debounce duplicate container open events within 2000ms
    if (now - lastTriggered < 2000) {
      return;
    }

    this.recentEvents.set(eventKey, now);

    // Auto-prune stale debounce keys when cache grows to prevent memory leaks
    if (this.recentEvents.size > 25) {
      this.cleanupDebounceCache();
    }

    // Check ignore list before notifying
    if (await IgnoreListStorage.isIgnored(player)) {
      logger.debug(`[ContainerMonitor] Suppressed container activity alert for ignored player: ${player}`, this.accountId);
      return;
    }

    if (this.notificationService) {
      this.notificationService.notifyContainerActivity({
        player,
        type: containerType,
        position,
        playerPos,
        accountId: this.accountId,
      });
    }
  }

  public cleanupDebounceCache(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.recentEvents.entries()) {
      if (now - timestamp > 10000) {
        this.recentEvents.delete(key);
      }
    }
  }

  public clear(): void {
    this.recentEvents.clear();
  }
}
