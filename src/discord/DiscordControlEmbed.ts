import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
  TextChannel,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { BedrockBot, ConnectionState } from '../network/BedrockBot';
import { BotOrData } from './DiscordChannelManager';
import { logger } from '../utils/logger';

interface StoredMessageData {
  channelId: string;
  messageId: string;
}

export class DiscordControlEmbed {
  private static stateFilePath = path.resolve(process.cwd(), 'data', 'discord_state.json');
  private static updateDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private static cachedState: Record<string, StoredMessageData> | null = null;
  private static lastRenderedDigest: Map<string, string> = new Map();
  private static inFlightUpdates: Map<string, Promise<void>> = new Map();
  private static recoveredBots: Set<string> = new Set();

  private static loadState(): Record<string, StoredMessageData> {
    if (this.cachedState) {
      return this.cachedState;
    }

    try {
      if (!fs.existsSync(this.stateFilePath)) {
        this.cachedState = {};
        return this.cachedState;
      }
      const data = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
      const res: Record<string, StoredMessageData> = typeof data === 'object' && data !== null ? data : {};
      this.cachedState = res;
      return res;
    } catch {
      this.cachedState = {};
      return this.cachedState;
    }
  }

  private static saveState(state: Record<string, StoredMessageData>): void {
    try {
      this.cachedState = state;
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      logger.error('Failed to save discord_state.json', undefined, err);
    }
  }

  public static buildControlEmbed(bot: BedrockBot | BotOrData): EmbedBuilder {
    const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
    const accountId = (bot as any).accountId || (bot as any).id || 'bot';
    const gamerTag = (bot as any).xboxUsername || (bot as any).gamertag || accountId;
    const ign = (bot as any).inGameIgn || (bot as any).ign || `${floodgatePrefix}${gamerTag}`;
    const isOnline = typeof (bot as any).getState === 'function'
      ? (bot as any).getState() === ConnectionState.CONNECTED
      : ((bot as any).status === 'CONNECTED' || (bot as any).state === 'CONNECTED' || (bot as any).status === 'online');
    let statusText = isOnline ? 'Online' : ((bot as any).status || (bot as any).state || 'Offline');

    const authIdent = (bot as any).authManager?.getIdentity ? (bot as any).authManager.getIdentity() : null;
    const authStatus = (bot as any).authManager?.getStatus ? (bot as any).authManager.getStatus() : ((bot as any).auth_status || (bot as any).authStatus);

    if (authStatus === 'XBOX_PROFILE_REQUIRED') {
      statusText = 'Xbox Profile Required';
    } else if (authStatus === 'VERIFICATION_REQUIRED') {
      statusText = 'Verification Required';
    } else if (authStatus === 'AUTHENTICATING') {
      statusText = 'Authenticating...';
    } else if (authStatus === 'CHECKING_XBOX_PROFILE') {
      statusText = 'Checking Xbox Profile...';
    } else if (typeof (bot as any).getState === 'function' && (bot as any).getState() === ConnectionState.CONNECTING) {
      statusText = 'Connecting...';
    } else if (typeof (bot as any).getState === 'function' && (bot as any).getState() === ConnectionState.RECONNECTING) {
      statusText = 'Reconnecting...';
    }

    const pos = (bot as any).currentPosition || {
      x: (bot as any).pos_x ?? 0,
      y: (bot as any).pos_y ?? 0,
      z: (bot as any).pos_z ?? 0,
    };
    const locationText = `${Math.round(pos.x)}-${Math.round(pos.y)}-${Math.round(pos.z)}`;
    const nodeId = (bot as any).node_id || (bot as any).nodeId || 'Master';

    let desc =
      `GamerTag: ${gamerTag}\n` +
      `IGN: ${ign}\n` +
      `Status: ${statusText}\n` +
      `Location: ${locationText}\n` +
      `Node: ${nodeId}`;

    if (authIdent?.xuid) {
      desc += `\nXUID: ${authIdent.xuid}`;
    }

    const msaCode = (bot as any).msaCodeData?.user_code || (bot as any).msa_code;
    const msaUrl = (bot as any).msaCodeData?.verification_uri || (bot as any).msa_url || 'https://microsoft.com/link';

    if (authStatus === 'XBOX_PROFILE_REQUIRED') {
      desc += `\n⚠️ **Xbox Profile Required**: Please visit https://account.xbox.com/profile to set up your Gamertag, then click **Retry Profile Check**.`;
    } else if (authStatus === 'VERIFICATION_REQUIRED' && msaCode) {
      desc += `\n🔑 **Auth Code**: Enter \`${msaCode}\` at ${msaUrl}`;
    }

    const publicUrl =
      process.env.PUBLIC_BASE_URL ||
      (process.env.NGROK_DOMAIN ? `https://${process.env.NGROK_DOMAIN.replace(/^https?:\/\//, '')}` : null);
    if (publicUrl) {
      desc += `\nDashboard: ${publicUrl}`;
    }

    const color = isOnline
      ? 0x22c55e
      : authStatus === 'XBOX_PROFILE_REQUIRED'
      ? 0xf59e0b
      : 0xef4444;

    return new EmbedBuilder()
      .setColor(color)
      .setDescription(desc);
  }

  public static buildControlButtons(bot: BedrockBot | BotOrData): ActionRowBuilder<ButtonBuilder>[] {
    const accountId = (bot as any).accountId || (bot as any).id || 'bot';
    const isOnline = typeof (bot as any).getState === 'function'
      ? (bot as any).getState() === ConnectionState.CONNECTED
      : ((bot as any).status === 'CONNECTED' || (bot as any).state === 'CONNECTED' || (bot as any).status === 'online');
    const isAfkActive = (bot as any).afkSpotTracker?.isActive
      ? (bot as any).afkSpotTracker.isActive()
      : Boolean((bot as any).afk_spot_active || (bot as any).isAfkSpotActive);
    const authStatus = (bot as any).authManager?.getStatus ? (bot as any).authManager.getStatus() : ((bot as any).auth_status || (bot as any).authStatus);

    const tpacceptBtn = new ButtonBuilder()
      .setCustomId(`btn_tpaccept_${accountId}`)
      .setLabel('Tpaccept')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isOnline);

    const joinBtn = new ButtonBuilder()
      .setCustomId(`btn_join_${accountId}`)
      .setLabel('Join')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isOnline);

    const leaveBtn = new ButtonBuilder()
      .setCustomId(`btn_leave_${accountId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isOnline);

    const setAfkBtn = new ButtonBuilder()
      .setCustomId(`btn_setafk_${accountId}`)
      .setLabel(isAfkActive ? 'Set Afk (Active)' : 'Set Afk')
      .setStyle(isAfkActive ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isOnline);

    const unafkBtn = new ButtonBuilder()
      .setCustomId(`btn_unafk_${accountId}`)
      .setLabel('UnAFK')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isAfkActive);

    const isCrouching = (bot as any).actionController?.isCrouching !== undefined
      ? Boolean((bot as any).actionController.isCrouching)
      : Boolean((bot as any).actionStates?.isCrouching || (bot as any).isCrouching);

    const crouchBtn = new ButtonBuilder()
      .setCustomId(`btn_crouch_${accountId}`)
      .setLabel(isCrouching ? 'Crouch (ON)' : 'Toggle Crouch')
      .setStyle(isCrouching ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isOnline);

    const retryProfileBtn = new ButtonBuilder()
      .setCustomId(`btn_retry_profile_${accountId}`)
      .setLabel('Retry Profile Check')
      .setStyle(ButtonStyle.Secondary);

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      tpacceptBtn,
      joinBtn,
      leaveBtn
    );
    rows.push(row1);

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      setAfkBtn,
      unafkBtn,
      crouchBtn
    );
    rows.push(row2);

    const publicUrl =
      process.env.PUBLIC_BASE_URL ||
      (process.env.NGROK_DOMAIN ? `https://${process.env.NGROK_DOMAIN.replace(/^https?:\/\//, '')}` : null);

    const row3Components: ButtonBuilder[] = [];

    if (publicUrl) {
      const dashboardBtn = new ButtonBuilder()
        .setLabel('Open Dashboard')
        .setStyle(ButtonStyle.Link)
        .setURL(publicUrl);
      row3Components.push(dashboardBtn);
    }

    if (authStatus === 'XBOX_PROFILE_REQUIRED' || !isOnline) {
      row3Components.push(retryProfileBtn);
    }

    if (row3Components.length > 0) {
      const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(...row3Components);
      rows.push(row3);
    }

    return rows;
  }

  /**
   * Purges all messages in a bot channel so it starts completely fresh and clean on start.
   */
  public static async clearChannelMessages(channel: TextChannel): Promise<void> {
    try {
      // 1. Bulk delete recent messages (< 14 days old)
      await channel.bulkDelete(100, true).catch(() => {});

      // 2. Fetch and delete any remaining older messages
      const remaining = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (remaining && remaining.size > 0) {
        for (const [, msg] of remaining) {
          await msg.delete().catch(() => {});
        }
      }
    } catch (err: any) {
      logger.debug(`Failed to clear messages in #${channel.name}: ${err?.message || err}`);
    }
  }

  /**
   * Clears the channel messages and posts a fresh control embed on start every time.
   */
  public static async clearChannelAndPostNewEmbed(
    bot: BedrockBot | BotOrData,
    channel: TextChannel
  ): Promise<void> {
    const accountId = (bot as any).accountId || (bot as any).id || 'bot';

    // 1. Purge all existing channel messages
    await this.clearChannelMessages(channel);

    // 2. Build and post fresh embed
    const embed = this.buildControlEmbed(bot);
    const buttons = this.buildControlButtons(bot);
    const digest = `${embed.data.title || ''}|${embed.data.description || ''}|${embed.data.color || ''}|${buttons.length}`;

    try {
      const newMsg = await channel.send({
        embeds: [embed],
        components: buttons,
      });

      const state = this.loadState();
      state[accountId] = {
        channelId: channel.id,
        messageId: newMsg.id,
      };
      this.saveState(state);
      this.lastRenderedDigest.set(accountId, digest);
      logger.debug(`Cleared channel messages and posted fresh control embed (ID: ${newMsg.id}) in #${channel.name}`, accountId);
    } catch (err) {
      logger.debug(`Failed to post fresh control embed message in channel #${channel.name}: ${err}`, accountId);
    }
  }

  public static async postOrUpdateEmbed(bot: BedrockBot | BotOrData, channel: TextChannel): Promise<void> {
    const accountId = String((bot as any).accountId || (bot as any).id || 'bot');

    // Prevent concurrent duplicate executions for the same bot account
    const inFlight = this.inFlightUpdates.get(accountId);
    if (inFlight) {
      return inFlight;
    }

    const updatePromise = (async () => {
      const state = this.loadState();
      let stored = state[accountId];

      const embed = this.buildControlEmbed(bot);
      const buttons = this.buildControlButtons(bot);

      // Compute a lightweight content digest to skip redundant Discord API edit calls
      const digest = `${embed.data.title || ''}|${embed.data.description || ''}|${embed.data.color || ''}|${buttons.length}`;

      let targetMsg: Message | null = null;

      // 1. Check existing stored message ID
      if (stored && stored.channelId === channel.id && stored.messageId) {
        try {
          targetMsg =
            channel.messages.cache.get(stored.messageId) ||
            (await channel.messages.fetch(stored.messageId).catch(() => null));
          if (targetMsg) {
            this.recoveredBots.add(accountId);
          }
        } catch {
          targetMsg = null;
        }
      }

      // 2. Node restart recovery: If no stored message found in local state (or state lost on restart/redeploy),
      // scan channel messages to discover and adopt any existing control embed sent by this bot!
      if (!targetMsg) {
        try {
          const recentMessages = await channel.messages.fetch({ limit: 15 }).catch(() => null);
          if (recentMessages) {
            const myId = channel.client.user?.id;
            const botEmbedMessages = recentMessages.filter(
              (m) => m.author.id === myId && m.embeds.length > 0
            );
            if (botEmbedMessages.size > 0) {
              // Sort so we adopt the newest embed message
              const sorted = Array.from(botEmbedMessages.values()).sort(
                (a, b) => b.createdTimestamp - a.createdTimestamp
              );
              targetMsg = sorted[0];

              // Prune any other duplicate/orphaned bot embed messages in the channel to keep it clean
              for (let i = 1; i < sorted.length; i++) {
                sorted[i].delete().catch(() => {});
              }

              if (!this.recoveredBots.has(accountId)) {
                this.recoveredBots.add(accountId);
                logger.debug(`Recovered existing control embed message [${targetMsg.id}] in #${channel.name} after restart`, accountId);
              } else {
                logger.debug(`Recovered existing control embed message [${targetMsg.id}] in #${channel.name}`, accountId);
              }

              state[accountId] = {
                channelId: channel.id,
                messageId: targetMsg.id,
              };
              this.saveState(state);
              stored = state[accountId];
            }
          }
        } catch (scanErr) {
          logger.debug(`Could not scan channel for existing embed messages: ${scanErr}`);
        }
      }

      // 3. Edit existing message in-place
      if (targetMsg) {
        if (this.lastRenderedDigest.get(accountId) === digest) {
          // Content has not changed. Skip redundant Discord HTTP edit request!
          return;
        }

        try {
          await targetMsg.edit({
            embeds: [embed],
            components: buttons,
          });
          this.lastRenderedDigest.set(accountId, digest);
          return;
        } catch (err) {
          logger.debug(`Existing control message ${targetMsg.id} could not be edited, creating new one.`, accountId);
        }
      }

      // 4. Send fresh message only if none exists
      try {
        const newMsg = await channel.send({
          embeds: [embed],
          components: buttons,
        });

        state[accountId] = {
          channelId: channel.id,
          messageId: newMsg.id,
        };
        this.saveState(state);
        this.lastRenderedDigest.set(accountId, digest);
        this.recoveredBots.add(accountId);
        logger.debug(`Posted control embed message (ID: ${newMsg.id}) in #${channel.name}`, accountId);
      } catch (err) {
        logger.debug(`Failed to post control embed message in channel #${channel.name}: ${err}`, accountId);
      }
    })();

    this.inFlightUpdates.set(accountId, updatePromise);
    try {
      await updatePromise;
    } finally {
      this.inFlightUpdates.delete(accountId);
    }
  }

  public static queueEmbedUpdate(bot: BedrockBot | BotOrData, channel: TextChannel): void {
    const accountId = String((bot as any).accountId || (bot as any).id || 'bot');
    // If an update is already scheduled to fire, let it execute without pushing back indefinitely
    if (this.updateDebounceTimers.has(accountId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.updateDebounceTimers.delete(accountId);
      this.postOrUpdateEmbed(bot, channel).catch((err) => {
        logger.debug(`Throttled embed update failed for ${accountId}`, accountId);
      });
    }, 2000);

    this.updateDebounceTimers.set(accountId, timer);
  }

  public static deleteState(accountId: string): void {
    try {
      this.recoveredBots.delete(accountId);
      this.lastRenderedDigest.delete(accountId);
      const state = this.loadState();
      if (state[accountId]) {
        delete state[accountId];
        this.saveState(state);
        logger.debug(`Removed Discord embed state for account [${accountId}]`, accountId);
      }
      const timer = this.updateDebounceTimers.get(accountId);
      if (timer) {
        clearTimeout(timer);
        this.updateDebounceTimers.delete(accountId);
      }
    } catch (err) {
      logger.debug(`Failed to delete discord state for [${accountId}]: ${err}`, accountId);
    }
  }

  public static getStoredData(accountId: string): StoredMessageData | undefined {
    const state = this.loadState();
    return state[accountId];
  }

  public static async deleteEmbedMessage(
    accountId: string,
    client?: any,
    fallbackChannel?: TextChannel
  ): Promise<{ channelId?: string; messageId?: string }> {
    const state = this.loadState();
    const stored = state[accountId];
    const channelId = stored?.channelId || fallbackChannel?.id;
    const messageId = stored?.messageId;

    try {
      let channel: any = fallbackChannel;
      if (!channel && channelId && client) {
        channel = await client.channels.fetch(channelId).catch(() => null);
      }

      if (channel && channel.isTextBased()) {
        if (messageId) {
          const msg = await channel.messages.fetch(messageId).catch(() => null);
          if (msg) {
            await msg.delete().catch((err: any) => {
              logger.debug(`Failed to delete Discord embed message [${messageId}]: ${err?.message || err}`);
            });
            logger.debug(`Successfully deleted Discord control embed message [${messageId}] for [${accountId}]`, accountId);
          }
        }

        // Clean up any remaining bot embed messages in the channel
        try {
          const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
          if (recent && client?.user) {
            const botMsgs = recent.filter((m: any) => m.author.id === client.user.id && m.embeds?.length > 0);
            for (const [, bm] of botMsgs) {
              await bm.delete().catch(() => {});
            }
          }
        } catch {}
      }
    } catch (err: any) {
      logger.debug(`Error in deleteEmbedMessage for [${accountId}]: ${err?.message || err}`);
    } finally {
      this.deleteState(accountId);
    }

    return { channelId, messageId };
  }
}
