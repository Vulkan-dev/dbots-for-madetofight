import http from 'http';
import https from 'https';
import axios from 'axios';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger';
import { getAllNodes, insertCommand } from '../database/SupabaseClient';

const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 10 });

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
    const fallbackMaster = 'https://donut-bots-production-30ad.up.railway.app';
    const now = Date.now();
    // Cache for 5 minutes to avoid repeated Supabase queries
    if (this.cachedMasterUrl && now - this.lastMasterUrlLookup < 300000) {
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
    this.cachedMasterUrl = fallbackMaster;
    this.lastMasterUrlLookup = now;
    return fallbackMaster;
  }

  /**
   * Directly posts to DISCORD_WEBHOOK_URL if configured.
   * Delivers logs in under 100ms without bot channel latency.
   */
  public async sendToDirectWebhook(payload: any): Promise<boolean> {
    const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || '').trim();
    if (!webhookUrl) return false;

    try {
      let body: any = null;
      if (payload.type === 'join') {
        body = {
          embeds: [{
            title: '🟢 Bot Connected',
            color: 0x10b981,
            fields: [
              { name: 'Bot Name', value: payload.botName, inline: true },
              { name: 'In-Game IGN', value: payload.ign, inline: true },
              { name: 'Server', value: payload.serverHost, inline: true },
            ],
            timestamp: new Date().toISOString(),
          }],
        };
      } else if (payload.type === 'leave') {
        body = {
          embeds: [{
            title: '🔴 Bot Disconnected',
            color: 0xef4444,
            fields: [
              { name: 'Bot Name', value: payload.botName, inline: true },
              { name: 'In-Game IGN', value: payload.ign || payload.botName, inline: true },
              { name: 'Reason', value: payload.reason || 'Connection lost', inline: false },
            ],
            timestamp: new Date().toISOString(),
          }],
        };
      } else if (payload.type === 'player_detected') {
        body = {
          embeds: [{
            title: '🚨 Player Detected',
            color: 0xf59e0b,
            fields: [
              { name: '👤 Player', value: `**${payload.playerName}**`, inline: true },
              { name: '📏 Distance', value: `${Number(payload.distance).toFixed(1)} blocks away`, inline: true },
              { name: '📍 Coordinates', value: `\`${payload.posStr}\``, inline: false },
              { name: '🤖 Bot Account', value: payload.botName, inline: true },
            ],
            timestamp: new Date().toISOString(),
          }],
        };
      } else if (payload.type === 'afk') {
        body = { content: `[AFK LOG - ${payload.botName}] ${payload.message}` };
      }

      if (body) {
        await axios.post(webhookUrl, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 2500,
        });
        return true;
      }
    } catch (err: any) {
      logger.debug(`Direct Discord webhook dispatch failed: ${err?.message}`);
    }
    return false;
  }

  private async relayToMaster(payload: any): Promise<void> {
    // Fast path: if DISCORD_WEBHOOK_URL is set, send directly with 0ms relay delay
    if (await this.sendToDirectWebhook(payload)) {
      return;
    }

    const masterUrl = await this.getMasterNodeUrl();
    let httpDelivered = false;
    if (masterUrl) {
      try {
        const res = await axios.post(`${masterUrl}/api/internal/discord-log`, payload, {
          headers: { 'Content-Type': 'application/json' },
          httpAgent: httpKeepAlive,
          httpsAgent: httpsKeepAlive,
          timeout: 2500,
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
    if (now - lastJoin < 3000) {
      return;
    }
    this.lastJoinTimes.set(key, now);

    // If direct webhook is configured, dispatch immediately
    await this.sendToDirectWebhook({ type: 'join', botName, ign, serverHost });

    if (!this.client) {
      if (!process.env.DISCORD_WEBHOOK_URL) {
        await this.relayToMaster({ type: 'join', botName, ign, serverHost });
      }
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
   * Debounces repeated leave logs within 3 seconds.
   */
  public async logBotLeft(botName: string, ign: string, reason?: string): Promise<void> {
    const key = (botName || ign || 'bot').toLowerCase();
    const now = Date.now();
    const lastLeft = this.lastLeftTimes.get(key) || 0;

    let cleanReason = (reason || '').trim();
    if (!cleanReason || cleanReason.toLowerCase() === 'unknown' || cleanReason === 'undefined') {
      cleanReason = 'Connection lost / Server kick';
    } else if (cleanReason === 'Server disconnect packet received') {
      cleanReason = 'Server closed connection';
    } else if (cleanReason === 'Socket closed') {
      cleanReason = 'Socket closed by remote server';
    }

    if (now - lastLeft < 3000) {
      return;
    }
    this.lastLeftTimes.set(key, now);

    // If direct webhook is configured, dispatch immediately
    await this.sendToDirectWebhook({ type: 'leave', botName, ign, reason: cleanReason });

    if (!this.client) {
      if (!process.env.DISCORD_WEBHOOK_URL) {
        await this.relayToMaster({ type: 'leave', botName, ign, reason: cleanReason });
      }
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

    await this.sendToDirectWebhook({ type: 'afk', botName, message });

    if (!this.client) {
      if (!process.env.DISCORD_WEBHOOK_URL) {
        await this.relayToMaster({ type: 'afk', botName, message });
      }
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
    await this.sendToDirectWebhook({ type: 'player_detected', botName, playerName, distance, posStr });

    if (!this.client) {
      if (!process.env.DISCORD_WEBHOOK_URL) {
        await this.relayToMaster({ type: 'player_detected', botName, playerName, distance, posStr });
      }
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
