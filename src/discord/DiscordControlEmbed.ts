import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { BedrockBot, ConnectionState } from '../network/BedrockBot';
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

  public static buildControlEmbed(bot: BedrockBot): EmbedBuilder {
    const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
    const gamerTag = bot.xboxUsername || bot.accountId;
    const ign = bot.inGameIgn || `${floodgatePrefix}${gamerTag}`;
    const isOnline = bot.getState() === ConnectionState.CONNECTED;
    let statusText = isOnline ? 'Online' : 'Offline';

    const authIdent = bot.authManager ? bot.authManager.getIdentity() : null;
    const authStatus = bot.authManager ? bot.authManager.getStatus() : null;

    if (authStatus === 'XBOX_PROFILE_REQUIRED') {
      statusText = 'Xbox Profile Required';
    } else if (authStatus === 'VERIFICATION_REQUIRED') {
      statusText = 'Verification Required';
    } else if (authStatus === 'AUTHENTICATING') {
      statusText = 'Authenticating...';
    } else if (authStatus === 'CHECKING_XBOX_PROFILE') {
      statusText = 'Checking Xbox Profile...';
    } else if (bot.getState() === ConnectionState.CONNECTING) {
      statusText = 'Connecting...';
    } else if (bot.getState() === ConnectionState.RECONNECTING) {
      statusText = 'Reconnecting...';
    }

    const pos = bot.currentPosition;
    const locationText = `${Math.round(pos.x)}-${Math.round(pos.y)}-${Math.round(pos.z)}`;

    let desc =
      `GamerTag: ${gamerTag}\n` +
      `IGN: ${ign}\n` +
      `Status: ${statusText}\n` +
      `Location: ${locationText}`;

    if (authIdent?.xuid) {
      desc += `\nXUID: ${authIdent.xuid}`;
    }

    if (authStatus === 'XBOX_PROFILE_REQUIRED') {
      desc += `\n⚠️ **Xbox Profile Required**: Please visit https://account.xbox.com/profile to set up your Gamertag, then click **Retry Profile Check**.`;
    } else if (authStatus === 'VERIFICATION_REQUIRED' && bot.msaCodeData) {
      desc += `\n🔑 **Auth Code**: Enter \`${bot.msaCodeData.user_code}\` at ${bot.msaCodeData.verification_uri}`;
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

  public static buildControlButtons(bot: BedrockBot): ActionRowBuilder<ButtonBuilder>[] {
    const isOnline = bot.getState() === ConnectionState.CONNECTED;
    const isAfkActive = bot.afkSpotTracker ? bot.afkSpotTracker.isActive() : false;
    const authStatus = bot.authManager ? bot.authManager.getStatus() : null;

    const tpacceptBtn = new ButtonBuilder()
      .setCustomId(`btn_tpaccept_${bot.accountId}`)
      .setLabel('Tpaccept')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isOnline);

    const joinBtn = new ButtonBuilder()
      .setCustomId(`btn_join_${bot.accountId}`)
      .setLabel('Join')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isOnline);

    const leaveBtn = new ButtonBuilder()
      .setCustomId(`btn_leave_${bot.accountId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isOnline);

    const setAfkBtn = new ButtonBuilder()
      .setCustomId(`btn_setafk_${bot.accountId}`)
      .setLabel(isAfkActive ? 'Set Afk (Active)' : 'Set Afk')
      .setStyle(isAfkActive ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isOnline);

    const unafkBtn = new ButtonBuilder()
      .setCustomId(`btn_unafk_${bot.accountId}`)
      .setLabel('UnAFK')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isOnline || !isAfkActive);

    const isCrouching = bot.actionController ? bot.actionController.isCrouching : false;

    const crouchBtn = new ButtonBuilder()
      .setCustomId(`btn_crouch_${bot.accountId}`)
      .setLabel(isCrouching ? 'Crouch (ON)' : 'Crouch')
      .setStyle(isCrouching ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isOnline);

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      tpacceptBtn,
      joinBtn,
      leaveBtn
    );

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      setAfkBtn,
      unafkBtn,
      crouchBtn
    );

    const rows: ActionRowBuilder<ButtonBuilder>[] = [row1, row2];

    const retryProfileBtn = new ButtonBuilder()
      .setCustomId(`btn_retry_profile_${bot.accountId}`)
      .setLabel('Retry Profile Check')
      .setStyle(ButtonStyle.Secondary);

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

  public static async postOrUpdateEmbed(bot: BedrockBot, channel: TextChannel): Promise<void> {
    const accountId = bot.accountId;
    const state = this.loadState();
    const stored = state[accountId];

    const embed = this.buildControlEmbed(bot);
    const buttons = this.buildControlButtons(bot);

    // Compute a lightweight content digest to skip redundant Discord API edit calls
    const digest = `${embed.data.title || ''}|${embed.data.description || ''}|${embed.data.color || ''}|${buttons.length}`;

    if (stored && stored.channelId === channel.id && stored.messageId) {
      if (this.lastRenderedDigest.get(accountId) === digest) {
        // Content has not changed. Skip redundant Discord HTTP edit request!
        return;
      }

      try {
        // Fast-path: check in-memory cache first before doing network fetch
        const existingMsg =
          channel.messages.cache.get(stored.messageId) ||
          (await channel.messages.fetch(stored.messageId).catch(() => null));

        if (existingMsg) {
          await existingMsg.edit({
            embeds: [embed],
            components: buttons,
          });
          this.lastRenderedDigest.set(accountId, digest);
          return;
        }
      } catch (err) {
        logger.debug(`Existing control message ${stored.messageId} could not be fetched or edited, creating new one.`, accountId);
      }
    }

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
      logger.info(`Posted control embed message (ID: ${newMsg.id}) in #${channel.name}`, accountId);
    } catch (err) {
      logger.error(`Failed to post control embed message in channel #${channel.name}`, accountId, err);
    }
  }

  public static queueEmbedUpdate(bot: BedrockBot, channel: TextChannel): void {
    // If an update is already scheduled to fire, let it execute without pushing back indefinitely
    if (this.updateDebounceTimers.has(bot.accountId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.updateDebounceTimers.delete(bot.accountId);
      this.postOrUpdateEmbed(bot, channel).catch((err) => {
        logger.debug(`Throttled embed update failed for ${bot.accountId}`, bot.accountId);
      });
    }, 2000);

    this.updateDebounceTimers.set(bot.accountId, timer);
  }

  public static deleteState(accountId: string): void {
    try {
      this.lastRenderedDigest.delete(accountId);
      const state = this.loadState();
      if (state[accountId]) {
        delete state[accountId];
        this.saveState(state);
        logger.info(`Removed Discord embed state for account [${accountId}]`, accountId);
      }
      const timer = this.updateDebounceTimers.get(accountId);
      if (timer) {
        clearTimeout(timer);
        this.updateDebounceTimers.delete(accountId);
      }
    } catch (err) {
      logger.error(`Failed to delete discord state for [${accountId}]`, accountId, err);
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

      if (channel && channel.isTextBased() && messageId) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) {
          await msg.delete().catch((err: any) => {
            logger.debug(`Failed to delete Discord embed message [${messageId}]: ${err?.message || err}`);
          });
          logger.info(`Successfully deleted Discord control embed message [${messageId}] for [${accountId}]`, accountId);
        }
      }
    } catch (err: any) {
      logger.debug(`Error in deleteEmbedMessage for [${accountId}]: ${err?.message || err}`);
    } finally {
      this.deleteState(accountId);
    }

    return { channelId, messageId };
  }
}
