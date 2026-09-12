import {
  Client,
  GatewayIntentBits,
  Message,
  EmbedBuilder,
  Events,
  Interaction,
  InteractionType,
  ButtonInteraction,
  ChatInputCommandInteraction,
  TextChannel,
  User,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { AccountManager } from '../network/AccountManager';
import { BedrockBot, ConnectionState } from '../network/BedrockBot';
import { discordLogger } from './DiscordLogger';
import { DiscordChannelManager } from './DiscordChannelManager';
import { DiscordControlEmbed } from './DiscordControlEmbed';
import { PermissionStorage } from '../storage/PermissionStorage';
import { IgnoreListStorage } from '../storage/IgnoreListStorage';
import { AppConfig } from '../config';
import { logger } from '../utils/logger';
import {
  getAllAccounts,
  getAllNodes,
  insertCommand,
} from '../database/SupabaseClient';

export class DiscordBot {
  private client: Client;
  private manager: AccountManager;
  private appConfig?: AppConfig;
  private token: string;
  private channelManager: DiscordChannelManager | null = null;
  private botChannels: Map<string, TextChannel> = new Map();
  private hookedBotIds: Set<string> = new Set();

  constructor(manager: AccountManager, appConfig?: AppConfig) {
    this.manager = manager;
    this.appConfig = appConfig;
    this.token = process.env.DISCORD_TOKEN || '';

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    discordLogger.setClient(this.client);
    this.setupEvents();
  }

  private setupEvents(): void {
    this.client.on(Events.ClientReady, async () => {
      logger.info(`Discord Bot logged in as ${this.client.user?.tag}`);

      // Initialize channel manager if category ID configured
      const categoryId =
        this.appConfig?.discord.botCategoryId ||
        process.env.DISCORD_BOT_CATEGORY_ID ||
        '';
      const allowedUserId =
        this.appConfig?.discord.allowedUserId ||
        process.env.DISCORD_ALLOWED_USER_ID ||
        '';

      if (categoryId) {
        this.channelManager = new DiscordChannelManager(this.client, categoryId, allowedUserId);
        await this.syncAllBotChannels();

        // Periodic embed update every 5 minutes to keep timestamps and status in sync
        setInterval(async () => {
          if (!this.channelManager) return;
          const allBots = this.manager.getAllBots();
          for (const bot of allBots) {
            const ch = this.botChannels.get(bot.accountId) || (await this.channelManager.getOrCreateBotChannel(bot));
            if (ch) {
              this.botChannels.set(bot.accountId, ch);
              DiscordControlEmbed.queueEmbedUpdate(bot, ch);
            }
          }
        }, 300000);
      }

      // Register Slash Commands with Discord Application API
      try {
        await this.registerSlashCommands();
      } catch (err: any) {
        logger.debug(`Failed to register application slash commands: ${err?.message || err}`);
      }

      // Announce Vercel frontend URL if configured
      const frontendUrl = this.appConfig?.webServer?.frontendUrl;
      if (frontendUrl && frontendUrl !== '*' && this.appConfig?.discord.logChannelId) {
        this.broadcastDashboardLink(frontendUrl).catch(() => {});
      }
    });

    this.client.on('messageCreate', async (message: Message) => {
      if (message.author.bot) return;
      const content = message.content.trim();
      const prefix = content.startsWith(',') ? ',' : content.startsWith('/') ? '/' : null;
      if (!prefix) return;
      await this.handleCommand(message, prefix);
    });

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (interaction.type === InteractionType.MessageComponent && interaction.isButton()) {
        await this.handleButtonInteraction(interaction as ButtonInteraction);
      } else if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction as ChatInputCommandInteraction);
      }
    });

    // AccountManager lifecycle events
    this.manager.on('accountAdded', async (bot: BedrockBot) => {
      try {
        await this.setupBotChannel(bot);
      } catch (err) {
        logger.debug(`Error setting up channel for added bot [${bot.accountId}]: ${err}`);
      }
    });

    this.manager.on('accountRemoved', async (accountId: string, xboxUsername?: string) => {
      try {
        const cachedChannel = this.botChannels.get(accountId);
        this.botChannels.delete(accountId);
        this.hookedBotIds.delete(accountId);

        // 1. Delete control embed message first
        const { channelId } = await DiscordControlEmbed.deleteEmbedMessage(accountId, this.client, cachedChannel);

        // 2. Delete dedicated Discord bot channel completely
        let deleted = false;
        if (cachedChannel) {
          try {
            await cachedChannel.delete(`Bot account ${accountId} removed`);
            deleted = true;
            logger.info(`Deleted cached Discord channel #${cachedChannel.name} for removed bot [${accountId}]`, accountId);
          } catch (err) {
            logger.debug(`Could not delete cached channel for [${accountId}]: ${err}`);
          }
        }

        if (this.channelManager) {
          const res = await this.channelManager.deleteBotChannel(accountId, xboxUsername, channelId);
          if (res) deleted = true;
        }

        if (!deleted && channelId && this.client) {
          try {
            const ch = await this.client.channels.fetch(channelId).catch(() => null);
            if (ch && typeof (ch as any).delete === 'function') {
              await (ch as any).delete(`Bot account ${accountId} removed`);
              logger.info(`Deleted Discord channel (ID: ${channelId}) for removed bot [${accountId}]`, accountId);
            }
          } catch (err) {
            logger.debug(`Could not delete channel ID ${channelId}: ${err}`);
          }
        }
      } catch (err) {
        logger.debug(`Error cleaning up channel for removed bot [${accountId}]: ${err}`);
      }
    });
  }

  /**
   * Registers global slash commands (/add, /remove, /perms, /ignore, /list)
   */
  private async registerSlashCommands(): Promise<void> {
    if (!this.client.application) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('add')
        .setDescription('Grant bot permission and private channel access to a Discord user')
        .addStringOption((opt) =>
          opt
            .setName('user')
            .setDescription('Discord username, mention, or user ID')
            .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Revoke bot permission and private channel access from a Discord user')
        .addStringOption((opt) =>
          opt
            .setName('user')
            .setDescription('Discord username, mention, or user ID')
            .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName('perms')
        .setDescription('List all authorized Discord users'),
      new SlashCommandBuilder()
        .setName('ignore')
        .setDescription('Manage ignored Minecraft players (suppresses farm/chest proximity alerts)')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Add a Minecraft player to the ignore list')
            .addStringOption((opt) =>
              opt.setName('player').setDescription('Minecraft player name').setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove a Minecraft player from the ignore list')
            .addStringOption((opt) =>
              opt.setName('player').setDescription('Minecraft player name').setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('List all currently ignored Minecraft players')
        ),
      new SlashCommandBuilder()
        .setName('list')
        .setDescription('List all Minecraft bots and their status'),
      new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('Get the Vercel frontend dashboard URL'),
      new SlashCommandBuilder()
        .setName('removebot')
        .setDescription('Permanently remove a bot account and delete its Discord channel & embed')
        .addStringOption((opt) =>
          opt.setName('bot').setDescription('Bot ID to permanently remove').setRequired(true)
        ),
    ];

    await this.client.application.commands.set(commands as any);
    logger.info('Registered Discord slash commands: /add, /remove, /perms, /ignore, /list, /ngrok, /link, /removebot');
  }

  /**
   * Discovers or creates Discord channels and initial control embeds for all registered bots.
   */
  public async syncAllBotChannels(): Promise<void> {
    if (!this.channelManager) return;

    const allBots = this.manager.getAllBots();
    for (const bot of allBots) {
      await this.setupBotChannel(bot);
    }
  }

  private async setupBotChannel(bot: BedrockBot): Promise<void> {
    if (!this.channelManager) return;

    const channel = await this.channelManager.getOrCreateBotChannel(bot);
    if (!channel) return;

    this.botChannels.set(bot.accountId, channel);

    // Initial embed post or edit
    await DiscordControlEmbed.postOrUpdateEmbed(bot, channel);

    // Hook bot events once to update the control embed
    if (!this.hookedBotIds.has(bot.accountId)) {
      this.hookedBotIds.add(bot.accountId);

      bot.on('stateChanged', async () => {
        if (this.channelManager) {
          const ch = await this.channelManager.getOrCreateBotChannel(bot);
          if (ch) {
            this.botChannels.set(bot.accountId, ch);
            DiscordControlEmbed.queueEmbedUpdate(bot, ch);
          }
        }
      });

      bot.on('positionChanged', () => {
        const ch = this.botChannels.get(bot.accountId);
        if (ch) DiscordControlEmbed.queueEmbedUpdate(bot, ch);
      });

      bot.on('profileReady', async () => {
        if (this.channelManager) {
          const ch = await this.channelManager.getOrCreateBotChannel(bot);
          if (ch) {
            this.botChannels.set(bot.accountId, ch);
            DiscordControlEmbed.queueEmbedUpdate(bot, ch);
          }
        }
      });

      if (bot.authManager) {
        bot.authManager.on('statusChanged', async () => {
          if (this.channelManager) {
            const ch = await this.channelManager.getOrCreateBotChannel(bot);
            if (ch) {
              this.botChannels.set(bot.accountId, ch);
              DiscordControlEmbed.queueEmbedUpdate(bot, ch);
            }
          }
        });
      }
    }
  }

  public async broadcastDashboardLink(publicUrl: string): Promise<void> {
    const logChannelId =
      process.env.DISCORD_LOG_CHANNEL_ID ||
      '';

    if (logChannelId && this.client.isReady()) {
      try {
        const ch = await this.client.channels.fetch(logChannelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          const embed = new EmbedBuilder()
            .setTitle('🌐 Web GUI & Dashboard Link')
            .setColor(0x22c55e)
            .setDescription(`Access the Bot Management Web GUI:\n🔗 **[${publicUrl}](${publicUrl})**`)
            .addFields(
              { name: 'Local Access', value: `http://localhost:${process.env.WEB_PORT || 3000}`, inline: true },
              { name: 'Status', value: '🟢 Active', inline: true }
            )
            .setFooter({ text: 'Public Tunnel Access' })
            .setTimestamp();

          const openBtn = new ButtonBuilder()
            .setLabel('Open Dashboard')
            .setStyle(ButtonStyle.Link)
            .setURL(publicUrl);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(openBtn);

          await (ch as TextChannel).send({ embeds: [embed], components: [row] });
          logger.info(`Broadcasted Dashboard link to Discord channel #${(ch as TextChannel).name}`);
        }
      } catch (err) {
        logger.debug(`Could not broadcast dashboard link to log channel: ${err}`);
      }
    }

    // Also update all bot control embeds
    await this.syncAllBotChannels();
  }

  public async start(): Promise<void> {
    if (!this.token || this.token === 'YOUR_DISCORD_BOT_TOKEN_HERE') {
      logger.warn('DISCORD_TOKEN is missing or not configured in .env file. Discord Bot interface disabled.');
      return;
    }

    try {
      await this.client.login(this.token);

      if (this.client.isReady() && !this.channelManager) {
        const categoryId =
          this.appConfig?.discord.botCategoryId ||
          process.env.DISCORD_BOT_CATEGORY_ID ||
          '';
        const allowedUserId =
          this.appConfig?.discord.allowedUserId ||
          process.env.DISCORD_ALLOWED_USER_ID ||
          '';

        if (categoryId) {
          this.channelManager = new DiscordChannelManager(this.client, categoryId, allowedUserId);
          await this.syncAllBotChannels();
        }
      }
    } catch (err) {
      logger.error('Failed to log in Discord bot', undefined, err);
    }
  }

  /**
   * Resolves a Discord user by mention, ID, username, or display name
   */
  public async resolveDiscordUser(query: string, guild?: any): Promise<User | null> {
    let clean = query.trim();
    if (clean.toLowerCase().startsWith('discord')) {
      clean = clean.slice(7).trim();
    }
    if (!clean) return null;

    // 1. Mention match: <@123456789> or <@!123456789>
    const mentionMatch = clean.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
      return this.client.users.fetch(mentionMatch[1]).catch(() => null);
    }

    // 2. Numerical Snowflake ID (17-20 digits)
    if (/^\d{17,20}$/.test(clean)) {
      return this.client.users.fetch(clean).catch(() => null);
    }

    // 3. Guild member search
    if (guild && typeof guild.members?.fetch === 'function') {
      try {
        const searched = await guild.members.fetch({ query: clean, limit: 10 }).catch(() => null);
        if (searched && searched.size > 0) {
          const exact = searched.find(
            (m: any) =>
              m.user.username.toLowerCase() === clean.toLowerCase() ||
              m.user.tag.toLowerCase() === clean.toLowerCase() ||
              m.displayName.toLowerCase() === clean.toLowerCase()
          );
          if (exact) return exact.user;
          return searched.first().user;
        }
      } catch {
        // search failed, try cache
      }

      if (guild.members.cache) {
        const cached = guild.members.cache.find(
          (m: any) =>
            m.user.username.toLowerCase() === clean.toLowerCase() ||
            m.user.tag.toLowerCase() === clean.toLowerCase() ||
            m.displayName.toLowerCase() === clean.toLowerCase()
        );
        if (cached) return cached.user;
      }
    }

    // 4. Global client users cache
    const cachedUser = this.client.users.cache.find(
      (u) =>
        u.username.toLowerCase() === clean.toLowerCase() ||
        u.tag.toLowerCase() === clean.toLowerCase()
    );
    if (cachedUser) return cachedUser;

    return null;
  }

  /**
   * Verifies if caller is allowed to manage bot permissions or execute commands
   */
  public isCallerAuthorized(userId: string, member?: GuildMember | null): boolean {
    // Check env-configured primary user
    const envUser = process.env.DISCORD_ALLOWED_USER_ID;
    if (envUser && envUser.trim() === userId) return true;

    // Check Discord server admin permissions
    if (member && member.permissions) {
      if (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild)
      ) {
        return true;
      }
    }

    return false;
  }

  public async isCallerAuthorizedAsync(userId: string, member?: GuildMember | null): Promise<boolean> {
    if (this.isCallerAuthorized(userId, member)) return true;
    return PermissionStorage.isAllowed(userId);
  }

  /**
   * Handles button clicks from the control embed (Tpaccept, Join, Leave, Set Afk).
   */
  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId; // btn_<action>_<accountId>
    if (!customId.startsWith('btn_')) return;

    // Check permission via PermissionStorage or Administrator
    const isAllowed = this.isCallerAuthorized(interaction.user.id, interaction.member as GuildMember | null);
    if (!isAllowed) {
      await interaction.reply({
        content: 'You do not have permission to control this bot.',
        ephemeral: true,
      });
      return;
    }

    const parts = customId.split('_');
    if (customId.startsWith('btn_retry_profile_')) {
      const accountId = customId.replace('btn_retry_profile_', '');
      const bot = this.manager.getBot(accountId);
      if (!bot) {
        await interaction.reply({ content: `Bot account '${accountId}' not found.`, ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const success = await bot.authManager.retryProfileCheck();
      const authStatus = bot.authManager.getStatus();

      if (success) {
        await interaction.editReply({
          content: `✅ Xbox Profile verified for **${accountId}**! Scheduling connection...`,
        });
        this.manager.scheduleAccountConnect(accountId);
      } else if (authStatus === 'XBOX_PROFILE_REQUIRED') {
        await interaction.editReply({
          content: `⚠️ Account **${accountId}** still requires an Xbox profile setup. Please visit https://account.xbox.com/profile to set up your Gamertag, then try again.`,
        });
      } else {
        await interaction.editReply({
          content: `Profile check finished for **${accountId}**. Status: \`${authStatus}\``,
        });
      }

      const channel = this.botChannels.get(bot.accountId);
      if (channel) {
        await DiscordControlEmbed.postOrUpdateEmbed(bot, channel);
      }
      return;
    }

    if (parts.length < 3) return;

    const action = parts[1]; // tpaccept, join, leave, setafk
    const accountId = parts.slice(2).join('_');

    const bot = this.manager.getBot(accountId);
    if (!bot) {
      await interaction.reply({
        content: `Bot account '${accountId}' not found.`,
        ephemeral: true,
      });
      return;
    }

    try {
      if (action === 'tpaccept') {
        if (bot.getState() !== ConnectionState.CONNECTED) {
          await interaction.reply({ content: 'Bot is offline.', ephemeral: true });
          return;
        }
        bot.sendChat('/tpaccept');
        await interaction.reply({ content: 'Issued /tpaccept.', ephemeral: true });
      } else if (action === 'join') {
        const scheduled = this.manager.scheduleAccountConnect(bot.accountId);
        if (scheduled) {
          await interaction.reply({ content: 'Connection scheduled.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'Already connected or connecting.', ephemeral: true });
        }
      } else if (action === 'leave') {
        await this.manager.disconnectAccount(bot.accountId);
        await interaction.reply({ content: 'Bot disconnected.', ephemeral: true });
      } else if (action === 'setafk') {
        if (bot.getState() !== ConnectionState.CONNECTED) {
          await interaction.reply({ content: 'Bot must be online to set AFK.', ephemeral: true });
          return;
        }

        const { LocationStorage } = require('../storage/LocationStorage');
        const existingSpot = bot.afkSpotTracker.getSavedSpot() || LocationStorage.getLocation(bot.accountId);

        if (existingSpot) {
          // AFK spot already set! Prompt confirmation asks: "Do you want to reset the afk location?"
          const confirmBtn = new ButtonBuilder()
            .setCustomId(`btn_confirmafk_${bot.accountId}`)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Danger);

          const discardBtn = new ButtonBuilder()
            .setCustomId(`btn_discardafk_${bot.accountId}`)
            .setLabel('Discard')
            .setStyle(ButtonStyle.Secondary);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, discardBtn);

          await interaction.reply({
            content: 'Do you want to reset the afk location?',
            components: [row],
            ephemeral: true,
          });
          return;
        }

        // Set initial AFK location (/sethome 1)
        bot.afkSpotTracker.activateAfkMode();
        const pos = bot.currentPosition;
        const loc = `X ${Math.round(pos.x)}, Y ${Math.round(pos.y)}, Z ${Math.round(pos.z)}`;
        await interaction.reply({
          content: `AFK location saved (${loc}) and /sethome 1 issued. 5-minute monitoring active.`,
          ephemeral: true,
        });
      } else if (action === 'confirmafk') {
        if (bot.getState() !== ConnectionState.CONNECTED) {
          await interaction.reply({ content: 'Bot must be online to reset AFK location.', ephemeral: true });
          return;
        }
        // Upon clicking Confirm, execute /delhome 1 followed by /sethome 1
        bot.afkSpotTracker.resetAfkLocation();
        const pos = bot.currentPosition;
        const loc = `X ${Math.round(pos.x)}, Y ${Math.round(pos.y)}, Z ${Math.round(pos.z)}`;
        await interaction.update({
          content: `AFK location reset! Issued /delhome 1 and /sethome 1 at (${loc}).`,
          components: [],
        });
      } else if (action === 'discardafk') {
        await interaction.update({
          content: 'AFK location reset cancelled.',
          components: [],
        });
      } else if (action === 'unafk') {
        const { LocationStorage } = require('../storage/LocationStorage');
        const hasSpot = bot.afkSpotTracker.isActive() || LocationStorage.getLocation(bot.accountId);

        if (!hasSpot) {
          await interaction.reply({ content: 'AFK location is not currently set.', ephemeral: true });
          return;
        }

        // UnAFK: stop monitor, issue /delhome 1, delete from location.js
        bot.afkSpotTracker.deactivateAfkMode(true);
        await interaction.reply({
          content: 'UnAFK executed. Issued /delhome 1 and stopped 5-minute AFK monitoring.',
          ephemeral: true,
        });
      } else if (action === 'crouch') {
        if (bot.getState() !== ConnectionState.CONNECTED) {
          await interaction.reply({ content: 'Bot must be online to toggle crouch.', ephemeral: true });
          return;
        }
        const state = bot.actionController.toggleCrouch();
        await interaction.reply({
          content: `Crouch ${state ? 'ENABLED' : 'DISABLED'}.`,
          ephemeral: true,
        });
      }

      // Refresh embed immediately after button action
      const channel = this.botChannels.get(bot.accountId);
      if (channel) {
        await DiscordControlEmbed.postOrUpdateEmbed(bot, channel);
      }
    } catch (err: any) {
      logger.error(`Error handling button action ${action} for ${accountId}`, accountId, err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Action failed to execute.', ephemeral: true });
      }
    }
  }

  /**
   * Handles Discord Slash Commands (/add, /remove, /perms, /ignore, /list)
   */
  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { commandName } = interaction;
    const authorId = interaction.user.id;
    const member = interaction.member as GuildMember | null;

    if (commandName === 'add') {
      if (!this.isCallerAuthorized(authorId, member)) {
        await interaction.reply({ content: 'You do not have permission to manage bot permissions.', ephemeral: true });
        return;
      }
      const targetQuery = interaction.options.getString('user', true);
      const targetUser = await this.resolveDiscordUser(targetQuery, interaction.guild);
      if (!targetUser) {
        await interaction.reply({
          content: `Could not find Discord user matching '${targetQuery}'. Please provide a valid username, mention, or user ID.`,
          ephemeral: true,
        });
        return;
      }

      PermissionStorage.addAllowedUser(targetUser.id, targetUser.tag || targetUser.username);
      const updated = await this.channelManager?.updatePermissionForUser(targetUser.id, true);
      await interaction.reply({
        content: `Permission granted to **${targetUser.tag || targetUser.username}** (\`${targetUser.id}\`). Updated ${updated || 0} bot channel(s). Authorized to control bots.`,
      });
    } else if (commandName === 'remove') {
      if (!this.isCallerAuthorized(authorId, member)) {
        await interaction.reply({ content: 'You do not have permission to manage bot permissions.', ephemeral: true });
        return;
      }
      const targetQuery = interaction.options.getString('user', true);
      const targetUser = await this.resolveDiscordUser(targetQuery, interaction.guild);
      if (!targetUser) {
        await interaction.reply({ content: `Could not find Discord user matching '${targetQuery}'.`, ephemeral: true });
        return;
      }

      PermissionStorage.removeAllowedUser(targetUser.id);
      const updated = await this.channelManager?.updatePermissionForUser(targetUser.id, false);
      await interaction.reply({
        content: `Revoked bot permissions for **${targetUser.tag || targetUser.username}** (\`${targetUser.id}\`). Updated ${updated || 0} bot channel(s).`,
      });
    } else if (commandName === 'perms') {
      if (!this.isCallerAuthorized(authorId, member)) {
        await interaction.reply({ content: 'You do not have permission to view bot permissions.', ephemeral: true });
        return;
      }
      const embed = this.buildPermissionsEmbed();
      await interaction.reply({ embeds: [embed] });
    } else if (commandName === 'ignore') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') {
        const player = interaction.options.getString('player', true);
        const added = await IgnoreListStorage.addPlayer(player);
        if (added) {
          await interaction.reply({
            content: `Added player **${player}** to the ignore list. Bot will not notify when this player is near the farm or accesses chests.`,
          });
        } else {
          await interaction.reply({ content: `Player **${player}** is already in the ignore list.` });
        }
      } else if (sub === 'remove') {
        const player = interaction.options.getString('player', true);
        const removed = await IgnoreListStorage.removePlayer(player);
        if (removed) {
          await interaction.reply({ content: `Removed player **${player}** from the ignore list.` });
        } else {
          await interaction.reply({ content: `Player **${player}** was not found in the ignore list.` });
        }
      } else if (sub === 'list') {
        const list = await IgnoreListStorage.getIgnoredPlayers();
        if (list.length === 0) {
          await interaction.reply({ content: 'The ignore list is currently empty. All nearby players and chest interactions will trigger notifications.' });
        } else {
          const embed = new EmbedBuilder()
            .setTitle('Ignored Players (Alert Suppression)')
            .setColor(0x3b82f6)
            .setDescription(list.map((p) => `• \`${p}\``).join('\n'))
            .setFooter({ text: 'Bots will not notify on proximity or chest activity for these players.' })
            .setTimestamp();
          await interaction.reply({ embeds: [embed] });
        }
      }
    } else if (commandName === 'list') {
      const embed = this.buildBotListEmbed();
      await interaction.reply({ embeds: [embed] });
    } else if (commandName === 'dashboard' || commandName === 'link') {
      const publicUrl = this.appConfig?.webServer?.frontendUrl;
      if (publicUrl && publicUrl !== '*') {
        const embed = new EmbedBuilder()
          .setTitle('🌐 Bot Management Dashboard')
          .setColor(0x3b82f6)
          .setDescription(`Access the Web Dashboard:\n🔗 **[${publicUrl}](${publicUrl})**`)
          .setFooter({ text: 'Powered by Vercel + Supabase' })
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } else {
        await interaction.reply({
          content: '⚠️ No frontend URL configured. Set `FRONTEND_URL` in your Railway environment variables.',
          ephemeral: true,
        });
      }
    } else if (commandName === 'removebot') {
      if (!this.isCallerAuthorized(authorId, member)) {
        await interaction.reply({ content: 'You do not have permission to remove bots.', ephemeral: true });
        return;
      }
      const targetId = interaction.options.getString('bot', true).trim();
      const removed = await this.manager.forceRemoveAccount(targetId);
      if (removed) {
        await interaction.reply({
          content: `Permanently removed bot **${targetId}** and deleted its Discord channel and control embed.`,
        });
      } else {
        await interaction.reply({ content: `Bot **${targetId}** not found.`, ephemeral: true });
      }
    }
  }

  /**
   * Handles text message commands (e.g. /add discord Username, ,add discord Username, /ignore add player, ,list, etc.)
   */
  private async handleCommand(message: Message, prefix: string): Promise<void> {
    const rawContent = message.content.slice(prefix.length).trim();
    if (!rawContent) return;

    const parts = rawContent.split(/\s+/);
    const commandOrBot = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Command: /add discord <Username> or /add <Username>
    if (commandOrBot === 'add') {
      if (!this.isCallerAuthorized(message.author.id, message.member)) {
        await message.reply('You do not have permission to manage bot permissions.');
        return;
      }
      let query = args.join(' ').trim();
      if (query.toLowerCase().startsWith('discord')) {
        query = query.slice(7).trim();
      }
      if (!query) {
        await message.reply(`Usage: \`${prefix}add discord <Username/Mention/ID>\``);
        return;
      }

      const targetUser = await this.resolveDiscordUser(query, message.guild);
      if (!targetUser) {
        await message.reply(`Could not find Discord user matching '${query}'. Please provide a valid username, mention, or user ID.`);
        return;
      }

      PermissionStorage.addAllowedUser(targetUser.id, targetUser.tag || targetUser.username);
      const updated = await this.channelManager?.updatePermissionForUser(targetUser.id, true);
      await message.reply(`Permission granted to **${targetUser.tag || targetUser.username}** (\`${targetUser.id}\`). Updated ${updated || 0} bot channel(s). Authorized to control bots.`);
      return;
    }

    // Command: /remove discord <Username> or /remove <Username>
    if (commandOrBot === 'remove') {
      if (!this.isCallerAuthorized(message.author.id, message.member)) {
        await message.reply('You do not have permission to manage bot permissions.');
        return;
      }
      let query = args.join(' ').trim();
      if (query.toLowerCase().startsWith('discord')) {
        query = query.slice(7).trim();
      }
      if (!query) {
        await message.reply(`Usage: \`${prefix}remove <Username/Mention/ID>\``);
        return;
      }

      const targetUser = await this.resolveDiscordUser(query, message.guild);
      if (!targetUser) {
        await message.reply(`Could not find Discord user matching '${query}'.`);
        return;
      }

      PermissionStorage.removeAllowedUser(targetUser.id);
      const updated = await this.channelManager?.updatePermissionForUser(targetUser.id, false);
      await message.reply(`Revoked bot permissions for **${targetUser.tag || targetUser.username}** (\`${targetUser.id}\`). Updated ${updated || 0} bot channel(s).`);
      return;
    }

    // Command: /perms or /permissions
    if (commandOrBot === 'perms' || commandOrBot === 'permissions') {
      if (!this.isCallerAuthorized(message.author.id, message.member)) {
        await message.reply('You do not have permission to view bot permissions.');
        return;
      }
      const embed = this.buildPermissionsEmbed();
      await message.reply({ embeds: [embed] });
      return;
    }

    // Command: /ignore [add|remove|list] <player>
    if (commandOrBot === 'ignore' || commandOrBot === 'whitelist') {
      if (!this.isCallerAuthorized(message.author.id, message.member)) {
        await message.reply('You do not have permission to manage the ignore list.');
        return;
      }

      if (args.length === 0 || args[0].toLowerCase() === 'list') {
        const list = await IgnoreListStorage.getIgnoredPlayers();
        if (list.length === 0) {
          await message.reply('The ignore list is currently empty. All nearby players and chest interactions will trigger notifications.');
        } else {
          const embed = new EmbedBuilder()
            .setTitle('Ignored Players (Alert Suppression)')
            .setColor(0x3b82f6)
            .setDescription(list.map((p: string) => `• \`${p}\``).join('\n'))
            .setFooter({ text: 'Bots will not notify on proximity or chest activity for these players.' })
            .setTimestamp();
          await message.reply({ embeds: [embed] });
        }
        return;
      }

      const sub = args[0].toLowerCase();
      if (sub === 'add' && args.length > 1) {
        const player = args.slice(1).join(' ').trim();
        const added = await IgnoreListStorage.addPlayer(player);
        if (added) {
          await message.reply(`Added player **${player}** to the ignore list. Bot will not notify when this player is near the farm or accesses chests.`);
        } else {
          await message.reply(`Player **${player}** is already in the ignore list.`);
        }
        return;
      }

      if ((sub === 'remove' || sub === 'del' || sub === 'delete') && args.length > 1) {
        const player = args.slice(1).join(' ').trim();
        const removed = await IgnoreListStorage.removePlayer(player);
        if (removed) {
          await message.reply(`Removed player **${player}** from the ignore list.`);
        } else {
          await message.reply(`Player **${player}** was not found in the ignore list.`);
        }
        return;
      }

      // Default: /ignore <player> adds the player
      const player = args.join(' ').trim();
      const added = await IgnoreListStorage.addPlayer(player);
      if (added) {
        await message.reply(`Added player **${player}** to the ignore list. Bot will not notify when this player is near the farm or accesses chests.`);
      } else {
        await message.reply(`Player **${player}** is already in the ignore list.`);
      }
      return;
    }

    // Command: /list or ,list
    if (commandOrBot === 'list') {
      const embed = this.buildBotListEmbed();
      await message.reply({ embeds: [embed] });
      return;
    }

    // Command: /dashboard or /link — Vercel frontend URL
    if (commandOrBot === 'ngrok' || commandOrBot === 'link' || commandOrBot === 'dashboard') {
      const publicUrl = this.appConfig?.webServer?.frontendUrl;
      if (publicUrl && publicUrl !== '*') {
        const embed = new EmbedBuilder()
          .setTitle('🌐 Bot Management Dashboard')
          .setColor(0x3b82f6)
          .setDescription(`Access the Web Dashboard:\n🔗 **[${publicUrl}](${publicUrl})**`)
          .setFooter({ text: 'Powered by Vercel + Supabase' })
          .setTimestamp();
        await message.reply({ embeds: [embed] });
      } else {
        await message.reply('⚠️ No frontend URL configured. Set `FRONTEND_URL` in your Railway environment variables.');
      }
      return;
    }

    // Command: /afk <botname> or ,afk <botname>
    if (commandOrBot === 'afk' && args.length > 0) {
      const botName = args[0];
      const bot = this.manager.getBot(botName);
      if (bot) {
        bot.afkSpotTracker.activateAfkMode();
        const displayIgn = bot.inGameIgn || bot.xboxUsername || bot.accountId;
        await message.reply(`Activated AFK spot tracking for **${bot.accountId}** (\`${displayIgn}\`). Issued /sethome 1.`);
        const ch = this.botChannels.get(bot.accountId);
        if (ch) await DiscordControlEmbed.postOrUpdateEmbed(bot, ch);
      } else {
        await message.reply(`Bot **${botName}** not found.`);
      }
      return;
    }

    // Command: /removebot <botId> or ,removebot <botId>
    if (commandOrBot === 'removebot' || commandOrBot === 'deletebot') {
      if (!this.isCallerAuthorized(message.author.id, message.member)) {
        await message.reply('You do not have permission to remove bots.');
        return;
      }
      const targetId = args[0]?.trim();
      if (!targetId) {
        await message.reply(`Usage: \`${prefix}removebot <botId>\``);
        return;
      }
      const removed = await this.manager.forceRemoveAccount(targetId);
      if (removed) {
        await message.reply(`Permanently removed bot **${targetId}** and wiped all associated profile and cached data.`);
      } else {
        await message.reply(`Bot **${targetId}** not found.`);
      }
      return;
    }

    // Check if command is targeting a bot e.g. ,afk1 join, ,afk1 leave, ,afk1 /tpaccept, ,afk1 afk
    const bot = this.manager.getBot(commandOrBot);
    if (!bot) {
      logger.debug(`Discord command target '${commandOrBot}' not found.`);
      return;
    }

    if (args.length === 0) {
      await message.reply(`Usage: \`${prefix}${bot.accountId} join\`, \`${prefix}${bot.accountId} leave\`, \`${prefix}${bot.accountId} afk\`, or \`${prefix}${bot.accountId} <msg/command>\``);
      return;
    }

    const subCommand = args[0].toLowerCase();
    if (subCommand === 'join') {
      const scheduled = this.manager.scheduleAccountConnect(bot.accountId);
      if (scheduled) {
        await message.reply(`Scheduled connection for bot **${bot.accountId}**...`);
      } else {
        await message.reply(`Connection for **${bot.accountId}** is already queued or active.`);
      }
    } else if (subCommand === 'leave') {
      await this.manager.disconnectAccount(bot.accountId);
      await message.reply(`Disconnected bot **${bot.accountId}**.`);
    } else if (subCommand === 'afk') {
      bot.afkSpotTracker.activateAfkMode();
      const displayIgn = bot.inGameIgn || bot.xboxUsername || bot.accountId;
      await message.reply(`Activated AFK spot tracking for **${bot.accountId}** (\`${displayIgn}\`). Issued /sethome 1.`);
      const ch = this.botChannels.get(bot.accountId);
      if (ch) await DiscordControlEmbed.postOrUpdateEmbed(bot, ch);
    } else {
      // Treat the rest as in-game chat or command (e.g. ,afk1 /tpaccept or ,afk1 Hi)
      const chatOrCmd = args.join(' ');
      bot.sendChat(chatOrCmd);
      await message.reply(`Sent to **${bot.accountId}**: \`${chatOrCmd}\``);
    }
  }

  public buildPermissionsEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('Authorized Discord Users')
      .setColor(0x22c55e)
      .setDescription('Use `/add discord <User>` or `/remove <User>` to manage permissions.')
      .setTimestamp();
  }

  public buildBotListEmbed(): EmbedBuilder {
    const localBots = this.manager.getAllBots();
    const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';

    const lines: string[] = [];
    for (const bot of localBots) {
      const xboxOrId = bot.xboxUsername || bot.accountId;
      const ign = bot.inGameIgn || `${floodgatePrefix}${xboxOrId}`;
      const stateEmoji = bot.getState() === ConnectionState.CONNECTED ? '🟢' : '🔴';
      lines.push(`${stateEmoji} **${bot.accountId}** — \`${ign}\``);
    }

    return new EmbedBuilder()
      .setTitle('🤖 Bot Status — This Node')
      .setColor(0x3b82f6)
      .setDescription(
        lines.length > 0
          ? lines.join('\n')
          : '*No bots loaded on this node.*'
      )
      .setFooter({ text: 'For all nodes, check the Vercel dashboard.' })
      .setTimestamp();
  }

  /**
   * Builds an embed showing all nodes and their bot counts from Supabase.
   * Used when DISCORD_MASTER=true.
   */
  public async buildAllNodesEmbed(): Promise<EmbedBuilder> {
    try {
      const [nodes, accounts] = await Promise.all([getAllNodes(), getAllAccounts()]);

      const fields = nodes.map((node: any) => {
        const nodeBots = accounts.filter((a: any) => a.node_id === node.id);
        const onlineCount = nodeBots.filter((a: any) => a.status === 'CONNECTED').length;
        const statusEmoji = node.status === 'online' ? '🟢' : '🔴';
        return {
          name: `${statusEmoji} ${node.name} (\`${node.id}\`)`,
          value: `**${onlineCount}/${nodeBots.length}** bots online\n${node.url || 'No URL'}`,
          inline: false,
        };
      });

      return new EmbedBuilder()
        .setTitle('🌐 All Backend Nodes')
        .setColor(0x8b5cf6)
        .addFields(fields.length > 0 ? fields : [{ name: 'No nodes registered', value: 'No backends found in Supabase', inline: false }])
        .setTimestamp();
    } catch (err: any) {
      return new EmbedBuilder()
        .setTitle('All Backend Nodes')
        .setColor(0xef4444)
        .setDescription(`Failed to fetch nodes: ${err?.message}`)
        .setTimestamp();
    }
  }
}

