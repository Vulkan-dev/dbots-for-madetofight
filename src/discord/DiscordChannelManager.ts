import {
  Client,
  CategoryChannel,
  ChannelType,
  Guild,
  OverwriteType,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { BedrockBot } from '../network/BedrockBot';
import { PermissionStorage } from '../storage/PermissionStorage';
import { logger } from '../utils/logger';

export type BotOrData = BedrockBot | {
  accountId?: string;
  id?: string;
  xboxUsername?: string;
  gamertag?: string;
  inGameIgn?: string;
  ign?: string;
  nodeId?: string;
  node_id?: string;
};

export class DiscordChannelManager {
  private client: Client;
  private categoryId: string;
  private allowedUserId: string;

  constructor(client: Client, categoryId: string, allowedUserId: string = '') {
    this.client = client;
    this.categoryId = categoryId;
    this.allowedUserId = allowedUserId;
  }

  public getChannelNameForBot(bot: BotOrData): string {
    const accountId = (bot as any).accountId || (bot as any).id || 'bot';
    const raw = (bot as any).xboxUsername || (bot as any).gamertag || `bot-${accountId}`;
    let sanitized = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!sanitized) sanitized = `bot-${accountId}`;
    return sanitized;
  }

  private static channelCreationLocks: Map<string, Promise<TextChannel | null>> = new Map();

  public async getOrCreateBotChannel(bot: BotOrData, customCategoryId?: string): Promise<TextChannel | null> {
    const effectiveCategoryId = customCategoryId || this.categoryId;
    if (!effectiveCategoryId) {
      logger.debug('No Discord category ID configured. Skipping Discord bot channel management.');
      return null;
    }

    const accountId = (bot as any).accountId || (bot as any).id || 'unknown';
    const lockKey = `${effectiveCategoryId}_${accountId}`;

    // Deduplicate concurrent/in-flight channel requests for the same bot account and category
    const existingLock = DiscordChannelManager.channelCreationLocks.get(lockKey);
    if (existingLock) {
      return existingLock;
    }

    const task = this._doGetOrCreateBotChannel(bot, effectiveCategoryId);
    DiscordChannelManager.channelCreationLocks.set(lockKey, task);
    try {
      return await task;
    } finally {
      DiscordChannelManager.channelCreationLocks.delete(lockKey);
    }
  }

  private async _doGetOrCreateBotChannel(bot: BotOrData, effectiveCategoryId: string): Promise<TextChannel | null> {
    const accountId = (bot as any).accountId || (bot as any).id || 'unknown';
    const xboxUsername = (bot as any).xboxUsername || (bot as any).gamertag || '';
    const nodeId = (bot as any).nodeId || (bot as any).node_id || '';

    try {
      const category = await this.client.channels.fetch(effectiveCategoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
        logger.warn(`Configured category ID '${effectiveCategoryId}' is not a valid Category channel.`);
        return null;
      }

      const guild: Guild = (category as CategoryChannel).guild;
      
      // Ensure all guild channels are loaded into cache
      await guild.channels.fetch().catch(() => {});

      const expectedChannelName = this.getChannelNameForBot(bot);

      // Find all channels matching this bot strictly to prevent merging or conflicting with other bots/nodes
      const matchingChannels = guild.channels.cache.filter((ch) => {
        if (!ch || ch.type !== ChannelType.GuildText) return false;

        const topic = (ch as TextChannel).topic || '';

        // 1. Strict topic check: if the channel topic contains a bracketed account ID [xyz],
        // it MUST match this bot's accountId. If it has another bot's accountId, it NEVER matches!
        const topicBotIdMatch = topic.match(/\[([a-zA-Z0-9_-]+)\]/);
        if (topicBotIdMatch) {
          return topicBotIdMatch[1].toLowerCase() === accountId.toLowerCase();
        }

        // 2. Channels without account ID in topic: only match under effectiveCategoryId
        if (ch.parentId !== effectiveCategoryId) return false;

        return (
          ch.name === expectedChannelName ||
          ch.name === `bot-${accountId.toLowerCase()}` ||
          ch.name === accountId.toLowerCase() ||
          (xboxUsername && ch.name === xboxUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '')) ||
          (xboxUsername && ch.name === `bot-${xboxUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`)
        );
      });

      if (matchingChannels.size > 0) {
        const matchingArray = Array.from(matchingChannels.values()) as TextChannel[];
        // Sort ascending by creation timestamp so the primary/oldest channel is kept
        matchingArray.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        const primaryChannel = matchingArray[0];

        // Prune and auto-delete any duplicate channels that may have been created
        if (matchingArray.length > 1) {
          for (let i = 1; i < matchingArray.length; i++) {
            const dup = matchingArray[i];
            logger.warn(`Pruning duplicate Discord channel #${dup.name} (ID: ${dup.id}) for bot [${accountId}]`, accountId);
            dup.delete(`Duplicate channel cleanup for bot ${accountId}`).catch((err) => {
              logger.debug(`Failed to delete duplicate channel ${dup.id}: ${err?.message || err}`);
            });
          }
        }

        logger.info(`Found existing Discord channel #${primaryChannel.name} for bot [${accountId}] (Category: ${effectiveCategoryId})`, accountId);

        // If channel is under a different category, move it to the target category
        if (primaryChannel.parentId !== effectiveCategoryId && typeof (primaryChannel as any).setParent === 'function') {
          await (primaryChannel as any).setParent(effectiveCategoryId).catch(() => {});
        }

        // Ensure topic includes the accountId marker
        const expectedTopic = `Private control channel for DonutSMP Bedrock bot [${accountId}] (Node: ${nodeId || 'Master'})`;
        if (!primaryChannel.topic || !primaryChannel.topic.includes(`[${accountId}]`)) {
          primaryChannel.setTopic(expectedTopic).catch(() => {});
        }

        // If GamerTag is now known and channel name differs, rename channel to GamerTag
        if (xboxUsername && primaryChannel.name !== expectedChannelName) {
          primaryChannel.setName(expectedChannelName).catch((e) => {
            logger.debug(`Could not rename channel #${primaryChannel.name} to ${expectedChannelName}: ${e?.message || e}`);
          });
        }
        return primaryChannel;
      }

      const permissionOverwrites: any[] = [
        {
          id: guild.roles.everyone.id,
          type: OverwriteType.Role,
          deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
      ];

      if (this.client.user) {
        permissionOverwrites.push({
          id: this.client.user.id,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        });
      }

      // Add all authorized users from PermissionStorage and config
      const allAllowedUsers = await PermissionStorage.getAllAllowedUsers();
      const allAllowedIds = new Set<string>(allAllowedUsers.map(u => u.userId));
      if (this.allowedUserId && this.allowedUserId.trim()) {
        allAllowedIds.add(this.allowedUserId.trim());
      }

      for (const userId of allAllowedIds) {
        if (!userId) continue;
        permissionOverwrites.push({
          id: userId,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        });
      }

      const newChannel = await guild.channels.create({
        name: expectedChannelName,
        type: ChannelType.GuildText,
        parent: effectiveCategoryId,
        permissionOverwrites,
        topic: `Private control channel for DonutSMP Bedrock bot [${accountId}] (Node: ${nodeId || 'Master'})`,
      });

      logger.info(`Created private Discord channel #${newChannel.name} in category [${effectiveCategoryId}] for bot [${accountId}]`, accountId);
      return newChannel;
    } catch (err) {
      logger.error(`Failed to get or create Discord channel for bot [${accountId}]`, accountId, err);
      return null;
    }
  }

  /**
   * Updates permission overwrites across all bot channels in the category for a specific Discord user.
   */
  public async updatePermissionForUser(userId: string, allow: boolean): Promise<number> {
    if (!this.categoryId) return 0;

    let count = 0;
    try {
      const category = await this.client.channels.fetch(this.categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) return 0;

      const guild: Guild = (category as CategoryChannel).guild;
      await guild.channels.fetch().catch(() => {});

      const botChannels = guild.channels.cache.filter(
        (ch) => ch && ch.parentId === this.categoryId && ch.type === ChannelType.GuildText
      );

      for (const [, channel] of botChannels) {
        const textChannel = channel as TextChannel;
        try {
          if (allow) {
            await textChannel.permissionOverwrites.edit(userId, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
            }, { type: OverwriteType.Member });
          } else {
            await textChannel.permissionOverwrites.delete(userId);
          }
          count++;
        } catch (e: any) {
          logger.debug(`Failed to update permissions in #${textChannel.name} for user ${userId}: ${e?.message || e}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to update category channel permissions for user ${userId}`, undefined, err);
    }
    return count;
  }

  /**
   * Deletes the dedicated Discord channel for a bot account upon removal.
   */
  public async deleteBotChannel(botId: string, xboxUsername?: string, channelId?: string): Promise<boolean> {
    try {
      let deletedAny = false;

      // 1. Direct channel deletion by channelId if provided
      if (channelId) {
        try {
          const directCh = await this.client.channels.fetch(channelId).catch(() => null);
          if (directCh && (directCh.type === ChannelType.GuildText || typeof (directCh as any).delete === 'function')) {
            const chName = (directCh as any).name || channelId;
            await (directCh as any).delete(`Bot account ${botId} deleted`);
            logger.info(`Deleted Discord channel #${chName} (ID: ${channelId}) for removed bot [${botId}]`, botId);
            deletedAny = true;
          }
        } catch (err) {
          logger.debug(`Direct channel deletion by channelId [${channelId}] failed: ${err}`);
        }
      }

      const targetId = botId.toLowerCase();
      const targetUser = xboxUsername ? xboxUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '') : null;

      // 2. Search category if categoryId is configured - delete all matching channels
      if (this.categoryId) {
        const category = await this.client.channels.fetch(this.categoryId).catch(() => null);
        if (category && category.type === ChannelType.GuildCategory) {
          const guild: Guild = (category as CategoryChannel).guild;
          await guild.channels.fetch().catch(() => {});

          const channelsToDelete = guild.channels.cache.filter(
            (ch) =>
              ch &&
              ch.parentId === this.categoryId &&
              ch.type === ChannelType.GuildText &&
              (((ch as TextChannel).topic && (ch as TextChannel).topic?.includes(`[${botId}]`)) ||
                ch.name === `bot-${targetId}` ||
                ch.name === targetId ||
                (targetUser && (ch.name === targetUser || ch.name === `bot-${targetUser}`)))
          );

          for (const [, channel] of channelsToDelete) {
            await channel.delete(`Bot account ${botId} deleted`).catch(() => {});
            logger.info(`Deleted Discord channel #${(channel as any).name} for removed bot [${botId}]`, botId);
            deletedAny = true;
          }
        }
      }

      // 3. Fallback across all cached guilds - delete all matching channels
      for (const [, guild] of this.client.guilds.cache) {
        try {
          await guild.channels.fetch().catch(() => {});
          const channelsToDelete = guild.channels.cache.filter(
            (ch) =>
              ch &&
              ch.type === ChannelType.GuildText &&
              (((ch as TextChannel).topic && (ch as TextChannel).topic?.includes(`[${botId}]`)) ||
                ch.name === `bot-${targetId}` ||
                ch.name === targetId ||
                (targetUser && (ch.name === targetUser || ch.name === `bot-${targetUser}`)))
          );

          for (const [, channel] of channelsToDelete) {
            await channel.delete(`Bot account ${botId} deleted`).catch(() => {});
            logger.info(`Deleted Discord channel #${(channel as any).name} across guild for removed bot [${botId}]`, botId);
            deletedAny = true;
          }
        } catch (innerErr) {
          logger.debug(`Guild scan channel deletion failed for guild ${guild.id}: ${innerErr}`);
        }
      }

      return deletedAny;
    } catch (err) {
      logger.error(`Failed to delete Discord channel for bot [${botId}]`, botId, err);
      return false;
    }
  }
}
