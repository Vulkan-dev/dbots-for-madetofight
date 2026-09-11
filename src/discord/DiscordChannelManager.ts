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

export class DiscordChannelManager {
  private client: Client;
  private categoryId: string;
  private allowedUserId: string;

  constructor(client: Client, categoryId: string, allowedUserId: string = '') {
    this.client = client;
    this.categoryId = categoryId;
    this.allowedUserId = allowedUserId;
  }

  public getChannelNameForBot(bot: BedrockBot): string {
    const raw = bot.xboxUsername || `bot-${bot.accountId}`;
    let sanitized = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!sanitized) sanitized = `bot-${bot.accountId}`;
    return sanitized;
  }

  public async getOrCreateBotChannel(bot: BedrockBot): Promise<TextChannel | null> {
    if (!this.categoryId) {
      logger.debug('DISCORD_BOT_CATEGORY_ID is not configured. Skipping Discord bot channel management.');
      return null;
    }

    try {
      const category = await this.client.channels.fetch(this.categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        logger.warn(`Configured category ID '${this.categoryId}' is not a valid Category channel.`);
        return null;
      }

      const guild: Guild = (category as CategoryChannel).guild;
      
      // Ensure all guild channels are loaded into cache
      await guild.channels.fetch().catch(() => {});

      const expectedChannelName = this.getChannelNameForBot(bot);

      const existingChannel = guild.channels.cache.find(
        (ch) =>
          ch &&
          ch.parentId === this.categoryId &&
          ch.type === ChannelType.GuildText &&
          (((ch as TextChannel).topic && (ch as TextChannel).topic?.includes(`[${bot.accountId}]`)) ||
            ch.name === expectedChannelName ||
            ch.name === `bot-${bot.accountId.toLowerCase()}` ||
            ch.name === bot.accountId.toLowerCase() ||
            (bot.xboxUsername && ch.name === bot.xboxUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '')) ||
            (bot.xboxUsername && ch.name === `bot-${bot.xboxUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`))
      );

      if (existingChannel && existingChannel.isTextBased()) {
        logger.info(`Found existing Discord channel #${existingChannel.name} for bot [${bot.accountId}]`, bot.accountId);
        // If GamerTag is now known and channel name differs, rename channel to GamerTag
        if (bot.xboxUsername && existingChannel.name !== expectedChannelName) {
          existingChannel.setName(expectedChannelName).catch((e) => {
            logger.debug(`Could not rename channel #${existingChannel.name} to ${expectedChannelName}: ${e?.message || e}`);
          });
        }
        return existingChannel as TextChannel;
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
        parent: this.categoryId,
        permissionOverwrites,
        topic: `Private control channel for DonutSMP Bedrock bot [${bot.accountId}]`,
      });

      logger.info(`Created private Discord channel #${newChannel.name} for bot [${bot.accountId}]`, bot.accountId);
      return newChannel;
    } catch (err) {
      logger.error(`Failed to get or create Discord channel for bot [${bot.accountId}]`, bot.accountId, err);
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
      // 1. Direct channel deletion by channelId if provided
      if (channelId) {
        try {
          const directCh = await this.client.channels.fetch(channelId).catch(() => null);
          if (directCh && (directCh.type === ChannelType.GuildText || typeof (directCh as any).delete === 'function')) {
            const chName = (directCh as any).name || channelId;
            await (directCh as any).delete(`Bot account ${botId} deleted`);
            logger.info(`Deleted Discord channel #${chName} (ID: ${channelId}) for removed bot [${botId}]`, botId);
            return true;
          }
        } catch (err) {
          logger.debug(`Direct channel deletion by channelId [${channelId}] failed: ${err}`);
        }
      }

      const targetId = botId.toLowerCase();
      const targetUser = xboxUsername ? xboxUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '') : null;

      // 2. Search category if categoryId is configured
      if (this.categoryId) {
        const category = await this.client.channels.fetch(this.categoryId).catch(() => null);
        if (category && category.type === ChannelType.GuildCategory) {
          const guild: Guild = (category as CategoryChannel).guild;
          await guild.channels.fetch().catch(() => {});

          const channelToDelete = guild.channels.cache.find(
            (ch) =>
              ch &&
              ch.parentId === this.categoryId &&
              ch.type === ChannelType.GuildText &&
              (((ch as TextChannel).topic && (ch as TextChannel).topic?.includes(`[${botId}]`)) ||
                ch.name === `bot-${targetId}` ||
                ch.name === targetId ||
                (targetUser && (ch.name === targetUser || ch.name === `bot-${targetUser}`)))
          );

          if (channelToDelete) {
            await channelToDelete.delete(`Bot account ${botId} deleted`);
            logger.info(`Deleted Discord channel #${channelToDelete.name} for removed bot [${botId}]`, botId);
            return true;
          }
        }
      }

      // 3. Fallback across all cached guilds
      for (const [, guild] of this.client.guilds.cache) {
        try {
          await guild.channels.fetch().catch(() => {});
          const channelToDelete = guild.channels.cache.find(
            (ch) =>
              ch &&
              ch.type === ChannelType.GuildText &&
              (((ch as TextChannel).topic && (ch as TextChannel).topic?.includes(`[${botId}]`)) ||
                ch.name === `bot-${targetId}` ||
                (targetUser && (ch.name === targetUser || ch.name === `bot-${targetUser}`)))
          );

          if (channelToDelete) {
            await channelToDelete.delete(`Bot account ${botId} deleted`);
            logger.info(`Deleted Discord channel #${channelToDelete.name} across guild for removed bot [${botId}]`, botId);
            return true;
          }
        } catch (innerErr) {
          logger.debug(`Guild scan channel deletion failed for guild ${guild.id}: ${innerErr}`);
        }
      }

      return false;
    } catch (err) {
      logger.error(`Failed to delete Discord channel for bot [${botId}]`, botId, err);
      return false;
    }
  }
}
