import axios from 'axios';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger';
import { getAllNodes, insertCommand } from '../database/SupabaseClient';

export class DiscordLogger {
  private client: Client | null = null;
  private logChannelId: string;
  private joinChannelId: string;
  private leftChannelId: string;
  private cachedMasterUrl: string | null = null;
  private lastMasterUrlLookup: number = 0;
  private lastJoinTimes: Map<string, number> = new Map();
  private lastLeftTimes: Map<string, number> = new Map();

  constructor() {
    this.logChannelId = (process.env.DISCORD_LOG_CHANNEL_ID || '').trim();
    this.joinChannelId = (process.env.DISCORD_JOIN_LOG_CHANNEL_ID || '').trim();
    this.leftChannelId = (process.env.DISCORD_LEFT_LOG_CHANNEL_ID || '').trim();
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
    let httpDelivered = false;
    if (masterUrl) {
      try {
        const res = await axios.post(`${masterUrl}/api/internal/discord-log`, payload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        });
        if (res.status === 200) httpDelivered = true;
      } catch (err: any) {
        logger.debug(`HTTP relay to master Discord bot failed: ${err?.message}`);
      }
    }

    // Always ensure delivery via Supabase commands table for node-1 if HTTP failed or wasn't available
    if (!httpDelivered) {
      try {
        await insertCommand('node-1', null, 'DISCORD_LOG', payload);
        logger.debug(`Relayed Discord log (${payload.type} for ${payload.botName || 'bot'}) to master node via Supabase queue`);
      } catch (err: any) {
        logger.debug(`Supabase command relay failed: ${err?.message}`);
      }
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
      logger.debug(`Failed to send Discord embed to channel ${channelId}: ${err}`);
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
      logger.debug(`Failed to send Discord message to channel ${channelId}: ${err}`);
    }
  }

  /**
   * Logs a bot JOIN event to DISCORD_JOIN_LOG_CHANNEL_ID
   * Debounces repeated join logs within 45 seconds to prevent spam during connection flapping.
   */
  public async logBotJoin(botName: string, ign: string, serverHost: string): Promise<void> {
    const key = (botName || ign || 'bot').toLowerCase();
    const now = Date.now();
    const lastJoin = this.lastJoinTimes.get(key) || 0;
    if (now - lastJoin < 45000) {
      logger.debug(`Debounced duplicate Discord join log for [${key}] (last sent ${Math.round((now - lastJoin) / 1000)}s ago)`);
      return;
    }
    this.lastJoinTimes.set(key, now);

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

    const targetChannel = (process.env.DISCORD_JOIN_LOG_CHANNEL_ID || this.joinChannelId || '').trim();
    if (!targetChannel) return;
    await this.sendEmbedToChannel(targetChannel, embed);
  }

  /**
   * Logs a bot LEAVE event to DISCORD_LEFT_LOG_CHANNEL_ID
   * Debounces repeated leave logs within 45 seconds to prevent spam during connection flapping.
   */
  public async logBotLeft(botName: string, ign: string, reason?: string): Promise<void> {
    const key = (botName || ign || 'bot').toLowerCase();
    const now = Date.now();
    const lastLeft = this.lastLeftTimes.get(key) || 0;

    let cleanReason = (reason || '').trim();
    if (!cleanReason || cleanReason.toLowerCase() === 'unknown' || cleanReason === 'undefined') {
      cleanReason = 'Connection lost / Server kick';
    } else if (cleanReason === 'Server disconnect packet received') {
      cleanReason = 'Server closed connection / Proxy kick';
    } else if (cleanReason === 'Socket closed') {
      cleanReason = 'Socket closed by remote server';
    }

    if (now - lastLeft < 45000) {
      logger.debug(`Debounced duplicate Discord leave log for [${key}] (last sent ${Math.round((now - lastLeft) / 1000)}s ago)`);
      return;
    }
    this.lastLeftTimes.set(key, now);

    if (!this.client) {
      await this.relayToMaster({ type: 'leave', botName, ign, reason: cleanReason });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🔴 Bot Disconnected')
      .setColor(0xef4444) // Red
      .addFields(
        { name: 'Bot Name', value: botName, inline: true },
        { name: 'In-Game IGN', value: ign || botName, inline: true },
        { name: 'Reason', value: cleanReason, inline: false }
      )
      .setTimestamp();

    const targetChannel = (process.env.DISCORD_LEFT_LOG_CHANNEL_ID || this.leftChannelId || '').trim();
    if (!targetChannel) return;
    await this.sendEmbedToChannel(targetChannel, embed);
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

    const targetChannel = (process.env.DISCORD_LOG_CHANNEL_ID || this.logChannelId || '').trim();
    if (!targetChannel) return;
    await this.sendMessageToChannel(targetChannel, content);
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

    const targetChannel = (process.env.DISCORD_LOG_CHANNEL_ID || this.logChannelId || '').trim();
    if (!targetChannel) return;
    await this.sendEmbedToChannel(targetChannel, embed);
  }
}

export const discordLogger = new DiscordLogger();
