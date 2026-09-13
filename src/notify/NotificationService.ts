import axios from 'axios';
import { logger } from '../utils/logger';
import { Vector3D, MathUtils } from '../utils/MathUtils';
import { discordLogger } from '../discord/DiscordLogger';

export interface PlayerDetectedPayload {
  name: string;
  position: Vector3D;
  distance: number;
  accountId: string;
}

export interface ContainerActivityPayload {
  player: string;
  type: string;
  position: Vector3D;
  playerPos?: Vector3D;
  accountId: string;
}

export interface DefensiveActionPayload {
  target: string;
  position: Vector3D;
  accountId: string;
}

export class NotificationService {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  public setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  /**
   * Send formatted Embed payload to configured notification endpoint.
   * Uses Discord Webhook embed structure with plain text fallback.
   */
  private async sendWebhook(embed: any, fallbackText: string, accountId: string): Promise<void> {
    if (!this.endpoint || this.endpoint.trim() === '') {
      logger.debug(`Notification skipped (no endpoint configured):\n${fallbackText}`, accountId);
      return;
    }

    try {
      const payload = {
        content: '',
        embeds: [embed],
        text: fallbackText, // For generic webhook receivers
      };

      await axios.post(
        this.endpoint,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
      );
      logger.debug(`Notification sent successfully to endpoint`, accountId);
    } catch (error) {
      logger.debug(`Failed to dispatch notification webhook: ${error}`, accountId);
    }
  }

  public async notifyPlayerDetected(data: PlayerDetectedPayload): Promise<void> {
    const posStr = MathUtils.formatPos(data.position);
    logger.info(`[NOTIFY PLAYER] ${data.name} at ${posStr} (${data.distance.toFixed(1)}m)`, data.accountId);

    const embed = {
      title: '🚨 PLAYER DETECTED',
      color: 0xf59e0b, // Vibrant Amber
      fields: [
        { name: '👤 Player', value: `### ${data.name}`, inline: false },
        { name: '📏 Distance', value: `**${data.distance.toFixed(1)} blocks away**`, inline: false },
        { name: '📍 Coordinates', value: `\`${posStr}\``, inline: false },
        { name: '🤖 Bot Account', value: `**Account ${data.accountId}**`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    const fallback = `[PLAYER DETECTED] ${data.name} at ${posStr} (${data.distance.toFixed(1)}m) | Bot: ${data.accountId}`;
    await this.sendWebhook(embed, fallback, data.accountId);

    // Also dispatch to Discord channels (log channel & relay)
    try {
      await discordLogger.logPlayerDetected(data.accountId, data.name, data.distance, posStr);
    } catch {}
  }

  public async notifyContainerActivity(data: ContainerActivityPayload): Promise<void> {
    const chestPosStr = MathUtils.formatPos(data.position);
    const playerPosStr = data.playerPos ? MathUtils.formatPos(data.playerPos) : 'Unknown';

    logger.info(`[NOTIFY CONTAINER] ${data.type} opened by ${data.player} at Chest: ${chestPosStr} | Player: ${playerPosStr}`, data.accountId);

    const embed = {
      title: '📦 CONTAINER INTERACTION',
      color: 0x3b82f6, // Vibrant Blue
      fields: [
        { name: '📦 Container Type', value: `### ${data.type}`, inline: false },
        { name: '👤 Opened By', value: `### ${data.player}`, inline: false },
        { name: '📍 Chest Coordinates', value: `\`${chestPosStr}\``, inline: false },
        { name: '🚶 Player Coordinates', value: `\`${playerPosStr}\``, inline: false },
        { name: '🤖 Bot Account', value: `**Account ${data.accountId}**`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    const fallback = `[CONTAINER ACTIVITY] ${data.type} opened by ${data.player} at Chest: ${chestPosStr} | Player: ${playerPosStr} | Bot: ${data.accountId}`;
    await this.sendWebhook(embed, fallback, data.accountId);
  }

  public async notifyDefensiveAction(data: DefensiveActionPayload): Promise<void> {
    const posStr = MathUtils.formatPos(data.position);
    logger.info(`[NOTIFY DEFENSIVE] Target: ${data.target} at ${posStr}`, data.accountId);

    const embed = {
      title: '⚔️ DEFENSIVE COMBAT ENGAGED',
      color: 0xef4444, // Vibrant Red
      fields: [
        { name: '🎯 Target Entity', value: `### ${data.target}`, inline: false },
        { name: '📍 Coordinates', value: `\`${posStr}\``, inline: false },
        { name: '🤖 Bot Account', value: `**Account ${data.accountId}**`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    const fallback = `[DEFENSIVE ACTION] Target: ${data.target} at ${posStr} | Bot: ${data.accountId}`;
    await this.sendWebhook(embed, fallback, data.accountId);
  }
}
