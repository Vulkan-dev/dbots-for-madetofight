import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger';

export class DiscordLogger {
  private client: Client | null = null;
  private logChannelId: string;
  private joinChannelId: string;
  private leftChannelId: string;

  constructor() {
    this.logChannelId = process.env.DISCORD_LOG_CHANNEL_ID || '1544779083509141504';
    this.joinChannelId = process.env.DISCORD_JOIN_LOG_CHANNEL_ID || '1545612152797401188';
    this.leftChannelId = process.env.DISCORD_LEFT_LOG_CHANNEL_ID || '1545612172867145799';
  }

  public setClient(client: Client): void {
    this.client = client;
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
    await this.sendMessageToChannel(this.logChannelId, content);
  }
}

export const discordLogger = new DiscordLogger();
