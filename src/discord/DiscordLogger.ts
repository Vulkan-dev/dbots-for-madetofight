import axios from 'axios';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger';
import { getAllNodes } from '../database/SupabaseClient';

export class DiscordLogger {
  private client: Client | null = null;
  private logChannelId: string;
  private joinChannelId: string;
  private leftChannelId: string;
  private cachedMasterUrl: string | null = null;
  private lastMasterUrlLookup: number = 0;

  constructor() {
    this.logChannelId = process.env.DISCORD_LOG_CHANNEL_ID || '1544779083509141504';
    this.joinChannelId = process.env.DISCORD_JOIN_LOG_CHANNEL_ID || '1545612152797401188';
    this.leftChannelId = process.env.DISCORD_LEFT_LOG_CHANNEL_ID || '1545612172867145799';
  }

  public setClient(client: Client): void {
    this.client = client;
  }

  private async getMasterNodeUrl(): Promise<string | null> {
    if (process.env.MASTER_NODE_URL) return process.env.MASTER_NODE_URL;
    const now = Date.now();
    if (this.cachedMasterUrl && now - this.lastMasterUrlLookup < 60000) {
      return this.cachedMasterUrl;
    }
    try {
      const nodes = await getAllNodes();
      const master = nodes.find((n: any) => n.id === 'node-1' || (n.name && n.name.toUpperCase().includes('MASTER')));
      if (master && master.url) {
        this.cachedMasterUrl = master.url;
        this.lastMasterUrlLookup = now;
        return master.url;
      }
    } catch {}
    return null;
  }

  private async relayToMaster(payload: any): Promise<void> {
    const masterUrl = await this.getMasterNodeUrl();
    if (!masterUrl) return;
    try {
      await axios.post(`${masterUrl}/api/internal/discord-log`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 6000,
      });
    } catch (err: any) {
      logger.debug(`Relay to master Discord bot failed: ${err?.message}`);
    }
  }

  private async sendEmbedToChannel(channelId: string, embed: EmbedBuilder): Promise<void> {
    if (!this.client || !channelId) return;
    try {
      const channel =
        this.client.channels.cache.get(channelId) ||
        (await this.client.channels.fetch(channelId).catch(() => null));
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).send({ embeds: [embed] });
      }
    } catch (err) {
      logger.error(`Failed to send Discord embed to channel ${channelId}`, undefined, err);
    }
  }

  private async sendMessageToChannel(channelId: string, message: string): Promise<void> {
    if (!this.client || !channelId) return;
    try {
      const channel =
        this.client.channels.cache.get(channelId) ||
        (await this.client.channels.fetch(channelId).catch(() => null));
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).send(message);
      }
    } catch (err) {
      logger.error(`Failed to send Discord message to channel ${channelId}`, undefined, err);
    }
  }

  /**
   * Logs a bot JOIN event to DISCORD_JOIN_LOG_CHANNEL_ID
   */
  public async logBotJoin(botName: string, ign: string, serverHost: string): Promise<void> {
    if (!this.client) {
      await this.relayToMaster({ type: 'join', botName, ign, serverHost });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🟢 Bot Connected')
      .setColor(0x10b981) // Green
      .addFields(
        { name: 'Bot Name', value: botName, inline: true },
        { name: 'In-Game IGN', value: ign, inline: true },
        { name: 'Server', value: serverHost, inline: true }
      )
      .setTimestamp();

    await this.sendEmbedToChannel(this.joinChannelId, embed);
  }

  /**
   * Logs a bot LEAVE event to DISCORD_LEFT_LOG_CHANNEL_ID
   */
  public async logBotLeft(botName: string, ign: string, reason?: string): Promise<void> {
    if (!this.client) {
      await this.relayToMaster({ type: 'leave', botName, ign, reason });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🔴 Bot Disconnected')
      .setColor(0xef4444) // Red
      .addFields(
        { name: 'Bot Name', value: botName, inline: true },
        { name: 'In-Game IGN', value: ign || botName, inline: true },
        { name: 'Reason', value: reason || 'Disconnected', inline: false }
      )
      .setTimestamp();

    await this.sendEmbedToChannel(this.leftChannelId, embed);
  }

  /**
   * Logs AFK Spot & General Activity to DISCORD_LOG_CHANNEL_ID
   */
  public async logAfkActivity(botName: string, message: string): Promise<void> {
    const content = `[AFK LOG - ${botName}] ${message}`;
    logger.info(content, botName);

    if (!this.client) {
      await this.relayToMaster({ type: 'afk', botName, message });
      return;
    }

    await this.sendMessageToChannel(this.logChannelId, content);
  }

  /**
   * Logs Player Detected event to DISCORD_LOG_CHANNEL_ID
   */
  public async logPlayerDetected(botName: string, playerName: string, distance: number, posStr: string): Promise<void> {
    if (!this.client) {
      await this.relayToMaster({ type: 'player_detected', botName, playerName, distance, posStr });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🚨 Player Detected')
      .setColor(0xf59e0b) // Amber
      .addFields(
        { name: '👤 Player', value: `**${playerName}**`, inline: true },
        { name: '📏 Distance', value: `${distance.toFixed(1)} blocks away`, inline: true },
        { name: '📍 Coordinates', value: `\`${posStr}\``, inline: false },
        { name: '🤖 Bot Account', value: botName, inline: true }
      )
      .setTimestamp();

    await this.sendEmbedToChannel(this.logChannelId, embed);
  }
}

export const discordLogger = new DiscordLogger();
