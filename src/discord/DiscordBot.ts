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
  getAccountById,
  getAllAccounts,
  getAllNodes,
  insertCommand,
  getRegisteredNodeCategories,
} from '../database/SupabaseClient';

export class DiscordBot {
  private client: Client;
  private manager: AccountManager;
  private appConfig?: AppConfig;
  private token: string;
  private channelManager: DiscordChannelManager | null = null;
  private botChannels: Map<string, TextChannel> = new Map();
  private hookedBotIds: Set<string> = new Set();
  private nodeCategories: Map<string, string> = new Map();

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
        this.appConfig?.discord.nodeBotCategoryId ||
        process.env.NODE_DISCORD_BOT_CATEGORY_ID ||
        this.appConfig?.discord.botCategoryId ||
        process.env.DISCORD_BOT_CATEGORY_ID ||
        '';
      const allowedUserId =
        this.appConfig?.discord.allowedUserId ||
        process.env.DISCORD_ALLOWED_USER_ID ||
        '';

      if (categoryId) {
        this.channelManager = new DiscordChannelManager(this.client, categoryId, allowedUserId);
        
        // Initial sync on start: clears messages, sends fresh embed, and sweeps extra channels
        await this.syncAllBotChannels(true);
        await this.sweepExtraCategoryChannels();

        // 3rd: Periodic Discord embed refresh and extra channel sweep every 5 minutes (300,000 ms)
        setInterval(async () => {
          if (!this.channelManager) return;
          await this.refreshAllEmbeds();
          await this.sweepExtraCategoryChannels();
        }, 300000);

        // Periodic bot channel discovery sync every 60 seconds
        setInterval(async () => {
          if (!this.channelManager) return;
          await this.syncAllBotChannels(false);
        }, 60000);
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
            logger.debug(`Deleted cached Discord channel #${cachedChannel.name} for removed bot [${accountId}]`, accountId);
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
              logger.debug(`Deleted Discord channel (ID: ${channelId}) for removed bot [${accountId}]`, accountId);
            }
          } catch (err) {
            logger.debug(`Could not delete channel ID ${channelId}: ${err}`);
          }
        }
      } catch (err) {
        logger.debug(`Error cleaning up channel for removed bot [${accountId}]: ${err}`);
      }
    });

    this.manager.on('registerNodeCategory', async (nodeId: string, catId: string) => {
      try {
        await this.registerNodeCategory(nodeId, catId);
      } catch (err) {
        logger.debug(`Error registering node category for [${nodeId}]: ${err}`);
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
        .setDescription('List Minecraft bots across nodes or for a specific node')
        .addStringOption((opt) =>
          opt.setName('node').setDescription('Node ID or number (e.g. 2 or node-2)').setRequired(false)
        ),
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

  public resolveCategoryForNode(nodeId: string): string {
    if (!nodeId) return '';
    if (this.nodeCategories.has(nodeId)) {
      return this.nodeCategories.get(nodeId)!;
    }

    // Check environment variables on Master Node:
    const sanitized = nodeId.toUpperCase().replace(/[^A-Z0-9]/g, '_'); // e.g. "NODE_5"
    const numOnly = nodeId.replace(/\D+/g, ''); // e.g. "5"
    const envCandidates = [
      process.env[`${sanitized}_DISCORD_BOT_CATEGORY_ID`],
      process.env[`${sanitized}_CATEGORY_ID`],
      process.env[`NODE_${numOnly}_DISCORD_BOT_CATEGORY_ID`],
      process.env[`NODE_DISCORD_BOT_CATEGORY_ID_${sanitized}`],
      process.env[`NODE_DISCORD_BOT_CATEGORY_ID_${numOnly}`],
    ];
    for (const val of envCandidates) {
      if (val && val.trim()) {
        this.nodeCategories.set(nodeId, val.trim());
        return val.trim();
      }
    }

    if (nodeId === this.appConfig?.nodeId || nodeId === 'node-1' || nodeId.toLowerCase() === 'master') {
      const selfCat =
        this.appConfig?.discord.nodeBotCategoryId ||
        process.env.NODE_DISCORD_BOT_CATEGORY_ID ||
        this.appConfig?.discord.botCategoryId ||
        process.env.DISCORD_BOT_CATEGORY_ID ||
        '';
      if (selfCat) return selfCat;
    }

    // Do NOT fall back to Master's category for other nodes!
    // If a worker node has not configured or announced a category, return '' so its bots
    // are never mistakenly placed into Master's or another node's category.
    return '';
  }

  public async registerNodeCategory(nodeId: string, categoryId: string): Promise<void> {
    if (!nodeId || !categoryId) return;
    this.nodeCategories.set(nodeId, categoryId);
    logger.debug(`Registered Discord category [${categoryId}] for node '${nodeId}'`);
    await this.syncAllBotChannels();
  }

  /**
   * Discovers or creates Discord channels and initial control embeds for all registered bots
   * across this node and all remote worker nodes.
   */
  public async syncAllBotChannels(isStartup: boolean = false): Promise<void> {
    if (!this.channelManager) return;

    // 0. Auto-load all registered node categories from Supabase
    try {
      const storedCategories = await getRegisteredNodeCategories();
      for (const [nId, catId] of storedCategories.entries()) {
        if (!this.nodeCategories.has(nId)) {
          this.nodeCategories.set(nId, catId);
          logger.debug(`Loaded registered Discord category [${catId}] for node '${nId}' from Supabase`);
        }
      }
    } catch {}

    // 1. Local bots on this Master node - only create channels for CONNECTED bots
    const allBots = this.manager.getAllBots();
    for (const bot of allBots) {
      this.hookBotEvents(bot);
      if (bot.getState() === ConnectionState.CONNECTED) {
        await this.setupBotChannel(bot, isStartup);
      }
    }

    // 2. Discover and sync all bots across all remote worker nodes from Supabase
    try {
      const allAccounts = await getAllAccounts();
      for (const acc of allAccounts) {
        const accountId = acc.id;
        // Skip if already managed locally as a live BedrockBot
        if (this.manager.getBot(accountId)) continue;

        const isOnline = acc.status === 'CONNECTED' || acc.status === 'online';
        // 3rd: Only make channel after the bot connected to the server and is online!
        if (!isOnline && !this.botChannels.has(accountId)) {
          continue;
        }

        const targetCategory = this.resolveCategoryForNode(acc.node_id);
        if (!targetCategory) continue;

        const botData = {
          accountId,
          xboxUsername: acc.gamertag,
          gamertag: acc.gamertag,
          inGameIgn: acc.ign,
          ign: acc.ign,
          status: acc.status,
          pos_x: acc.pos_x,
          pos_y: acc.pos_y,
          pos_z: acc.pos_z,
          auth_status: acc.auth_status,
          auth_error: acc.auth_error,
          msa_code: acc.msa_code,
          msa_url: acc.msa_url,
          afk_spot_active: acc.afk_spot_active,
          node_id: acc.node_id,
        };

        const channel = await this.channelManager.getOrCreateBotChannel(botData, targetCategory);
        if (channel) {
          this.botChannels.set(accountId, channel);
          if (isStartup) {
            await DiscordControlEmbed.clearChannelAndPostNewEmbed(botData, channel);
          } else {
            await DiscordControlEmbed.postOrUpdateEmbed(botData, channel);
          }
        }
      }
    } catch (err: any) {
      logger.debug(`Remote bot sync error across nodes: ${err?.message || err}`);
    }
  }

  private async setupBotChannel(bot: BedrockBot, isStartup: boolean = false): Promise<void> {
    if (!this.channelManager) return;
    this.hookBotEvents(bot);

    // 3rd: Only make channel after the bot connected to the server and is online!
    if (bot.getState() !== ConnectionState.CONNECTED && !this.botChannels.has(bot.accountId)) {
      return;
    }

    const channel = await this.channelManager.getOrCreateBotChannel(bot);
    if (!channel) return;

    this.botChannels.set(bot.accountId, channel);
    if (isStartup) {
      await DiscordControlEmbed.clearChannelAndPostNewEmbed(bot, channel);
    } else {
      await DiscordControlEmbed.postOrUpdateEmbed(bot, channel);
    }
  }

  private hookBotEvents(bot: BedrockBot): void {
    if (this.hookedBotIds.has(bot.accountId)) return;
    this.hookedBotIds.add(bot.accountId);

    bot.on('stateChanged', async (newState: string) => {
      if (newState === ConnectionState.CONNECTED) {
        // Bot connected and is now online!
        if (this.channelManager) {
          const channelExisted = this.botChannels.has(bot.accountId);
          const ch = await this.channelManager.getOrCreateBotChannel(bot);
          if (ch) {
            this.botChannels.set(bot.accountId, ch);
            if (!channelExisted) {
              await DiscordControlEmbed.clearChannelAndPostNewEmbed(bot, ch);
            } else {
              await DiscordControlEmbed.postOrUpdateEmbed(bot, ch);
            }
          }
        }
      } else {
        // If channel already exists, update embed to reflect state change
        const ch = this.botChannels.get(bot.accountId);
        if (ch) {
          await DiscordControlEmbed.postOrUpdateEmbed(bot, ch);
        }
      }
    });

    bot.on('profileReady', async () => {
      if (this.channelManager && (bot.getState() === ConnectionState.CONNECTED || this.botChannels.has(bot.accountId))) {
        const ch = await this.channelManager.getOrCreateBotChannel(bot);
        if (ch) {
          this.botChannels.set(bot.accountId, ch);
          await DiscordControlEmbed.postOrUpdateEmbed(bot, ch);
        }
      }
    });
  }

  /**
   * Refreshes all active control embeds every 5 minutes without channel creation overhead.
   */
  public async refreshAllEmbeds(): Promise<void> {
    if (!this.channelManager) return;

    // 1. Local connected bots
    for (const bot of this.manager.getAllBots()) {
      if (bot.getState() === ConnectionState.CONNECTED) {
        const ch = this.botChannels.get(bot.accountId);
        if (ch) {
          await DiscordControlEmbed.postOrUpdateEmbed(bot, ch);
        }
      }
    }

    // 2. Remote connected bots from Supabase
    try {
      const allAccounts = await getAllAccounts();
      for (const acc of allAccounts) {
        if (this.manager.getBot(acc.id)) continue;
        const isOnline = acc.status === 'CONNECTED' || acc.status === 'online';
        if (!isOnline) continue;
        const ch = this.botChannels.get(acc.id);
        if (ch) {
          const botData = {
            accountId: acc.id,
            xboxUsername: acc.gamertag,
            gamertag: acc.gamertag,
            inGameIgn: acc.ign,
            ign: acc.ign,
            status: acc.status,
            pos_x: acc.pos_x,
            pos_y: acc.pos_y,
            pos_z: acc.pos_z,
            auth_status: acc.auth_status,
            auth_error: acc.auth_error,
            msa_code: acc.msa_code,
            msa_url: acc.msa_url,
            afk_spot_active: acc.afk_spot_active,
            node_id: acc.node_id,
          };
          await DiscordControlEmbed.postOrUpdateEmbed(botData, ch);
        }
      }
    } catch {}
  }

  /**
   * Sweeps all bot categories to delete any extra channels not belonging to any valid bot,
   * as well as any duplicate channels.
   */
  public async sweepExtraCategoryChannels(): Promise<void> {
    if (!this.channelManager) return;
    try {
      const allAccounts = await getAllAccounts().catch(() => []);

      // 1. Gather all active categories to sweep:
      const categoriesToSweep: Map<string, Array<{ id: string; gamertag?: string; ign?: string }>> = new Map();

      // Master Category:
      const masterCatId =
        this.appConfig?.discord.nodeBotCategoryId ||
        process.env.NODE_DISCORD_BOT_CATEGORY_ID ||
        this.appConfig?.discord.botCategoryId ||
        process.env.DISCORD_BOT_CATEGORY_ID ||
        '';

      if (masterCatId) {
        const masterBots: Array<{ id: string; gamertag?: string; ign?: string }> = [];
        const seenIds = new Set<string>();

        // Local bots on Master
        for (const bot of this.manager.getAllBots()) {
          masterBots.push({
            id: bot.accountId,
            gamertag: bot.xboxUsername,
            ign: bot.inGameIgn,
          });
          seenIds.add(bot.accountId.toLowerCase());
        }

        // Remote bots assigned to Master
        for (const acc of allAccounts) {
          const nid = (acc.node_id || '').toLowerCase();
          if (
            (!nid || nid === 'node-1' || nid === 'master' || nid === this.appConfig?.nodeId?.toLowerCase()) &&
            !seenIds.has(acc.id.toLowerCase())
          ) {
            masterBots.push({
              id: acc.id,
              gamertag: acc.gamertag,
              ign: acc.ign,
            });
            seenIds.add(acc.id.toLowerCase());
          }
        }
        categoriesToSweep.set(masterCatId, masterBots);
      }

      // Worker Categories:
      for (const [nodeId, catId] of this.nodeCategories.entries()) {
        if (!catId || categoriesToSweep.has(catId)) continue;
        const workerBots: Array<{ id: string; gamertag?: string; ign?: string }> = [];
        const targetNodeLower = nodeId.toLowerCase();
        const numOnly = targetNodeLower.replace(/\D+/g, '');

        for (const acc of allAccounts) {
          const nid = (acc.node_id || '').toLowerCase();
          if (
            nid === targetNodeLower ||
            (numOnly && nid === `node-${numOnly}`) ||
            (numOnly && nid === numOnly)
          ) {
            workerBots.push({
              id: acc.id,
              gamertag: acc.gamertag,
              ign: acc.ign,
            });
          }
        }
        categoriesToSweep.set(catId, workerBots);
      }

      // 2. Perform the sweep on each category:
      for (const [catId, validBots] of categoriesToSweep.entries()) {
        const purged = await this.channelManager.purgeExtraChannels(catId, validBots);
        if (purged > 0) {
          logger.info(`Category sweep: purged ${purged} extra/duplicate channel(s) from category [${catId}]`);
        }
      }
    } catch (err: any) {
      logger.debug(`Error sweeping category channels: ${err?.message || err}`);
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
          logger.debug(`Broadcasted Dashboard link to Discord channel #${(ch as TextChannel).name}`);
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
          this.appConfig?.discord.nodeBotCategoryId ||
          process.env.NODE_DISCORD_BOT_CATEGORY_ID ||
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

    if (interaction.channel && interaction.channel.isTextBased()) {
      const targetAccountId = customId.startsWith('btn_retry_profile_')
        ? customId.replace('btn_retry_profile_', '')
        : (parts.length >= 3 ? parts.slice(2).join('_') : '');
      if (targetAccountId && !this.botChannels.has(targetAccountId)) {
        this.botChannels.set(targetAccountId, interaction.channel as TextChannel);
      }
    }

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

    let bot = this.manager.getBot(accountId);
    if (!bot) {
      const accountRow = await getAccountById(accountId);
      if (accountRow && accountRow.node_id && accountRow.node_id !== this.appConfig?.nodeId) {
        const actionMap: Record<string, string> = {
          'tpaccept': 'CHAT',
          'join': 'CONNECT',
          'leave': 'DISCONNECT',
          'setafk': 'SET_AFK',
          'confirmafk': 'RESET_AFK',
          'unafk': 'TOGGLE_AFK_MONITOR',
          'crouch': 'BOT_ACTION',
          'retry_profile': 'RETRY_PROFILE',
        };
        const remoteAction = actionMap[action] || action.toUpperCase();
        const payload: any = {};
        if (action === 'tpaccept') payload.message = '/tpaccept';
        if (action === 'crouch') payload.action = 'toggle_crouch';

        await insertCommand(accountRow.node_id, accountId, remoteAction, payload);

        // Also attempt direct HTTP call if target node URL is known
        try {
          const nodes = await getAllNodes();
          const targetNode = nodes.find((n: any) => n.id === accountRow.node_id);
          if (targetNode && targetNode.url) {
            const axios = require('axios');
            if (action === 'tpaccept') {
              axios.post(`${targetNode.url}/api/bot/chat`, { accountId, message: '/tpaccept' }, { timeout: 4000 }).catch(() => {});
            } else if (action === 'join') {
              axios.post(`${targetNode.url}/api/accounts/connect`, { accountId }, { timeout: 4000 }).catch(() => {});
            } else if (action === 'leave') {
              axios.post(`${targetNode.url}/api/accounts/disconnect`, { accountId }, { timeout: 4000 }).catch(() => {});
            } else if (action === 'crouch') {
              axios.post(`${targetNode.url}/api/bot/action`, { accountId, action: 'toggle_crouch' }, { timeout: 4000 }).catch(() => {});
            }
          }
        } catch {}

        await interaction.reply({ content: `✅ Dispatched ${action} to ${accountRow.node_id} for bot #${accountId}.`, ephemeral: true });
        return;
      }

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
      const channel = this.botChannels.get(bot.accountId) || (interaction.channel as TextChannel);
      if (channel && channel.isTextBased()) {
        await DiscordControlEmbed.postOrUpdateEmbed(bot, channel as TextChannel);
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
      const nodeFilter = interaction.options.getString('node') || undefined;
      const embed = await this.buildBotListEmbed(nodeFilter);
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

    // Command: /list or ,list [node-id]
    if (commandOrBot === 'list') {
      const nodeFilter = args[0]?.trim();
      const embed = await this.buildBotListEmbed(nodeFilter);
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
    let bot = this.manager.getBot(commandOrBot);
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

  public async buildBotListEmbed(filterNode?: string): Promise<EmbedBuilder> {
    const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
    const allAccounts = await getAllAccounts().catch(() => []);

    if (filterNode && filterNode.trim()) {
      const raw = filterNode.trim().toLowerCase();
      const numOnly = raw.replace(/\D+/g, '');
      const targetNodeId = raw.startsWith('node-') ? raw : (raw === 'master' ? 'node-1' : (numOnly ? `node-${numOnly}` : raw));

      const accountsForNode = allAccounts.filter((a: any) => {
        const nid = (a.node_id || '').toLowerCase();
        return (
          nid === targetNodeId ||
          nid === raw ||
          (numOnly && nid === `node-${numOnly}`) ||
          (targetNodeId === 'node-1' && (!nid || nid === 'master' || nid === 'node-1'))
        );
      });

      const lines: string[] = [];
      for (const a of accountsForNode) {
        const isOnline = a.status === 'CONNECTED' || a.status === 'online';
        const stateEmoji = isOnline ? '🟢' : '🔴';
        const gamerTag = a.gamertag || a.id;
        const ign = a.ign || `${floodgatePrefix}${gamerTag}`;
        const loc = (a.pos_x != null && isOnline) ? ` (${Math.round(a.pos_x)}, ${Math.round(a.pos_y)}, ${Math.round(a.pos_z)})` : '';
        lines.push(`${stateEmoji} **#${a.id}** — \`${ign}\`${loc}`);
      }

      const onlineCount = accountsForNode.filter((a: any) => a.status === 'CONNECTED' || a.status === 'online').length;

      return new EmbedBuilder()
        .setTitle(`🤖 Bots on ${targetNodeId.toUpperCase()}`)
        .setColor(0x3b82f6)
        .setDescription(
          lines.length > 0
            ? `**${onlineCount}/${accountsForNode.length}** bots online\n\n` + lines.join('\n')
            : `*No bots found assigned to ${targetNodeId}.*`
        )
        .setFooter({ text: 'Use ,list <node-id> (e.g. ,list 2) to filter by node.' })
        .setTimestamp();
    }

    // Default overview when no node filter is provided
    const nodeMap: Map<string, any[]> = new Map();
    for (const a of allAccounts) {
      const nid = (a.node_id || 'unassigned').toLowerCase();
      if (!nodeMap.has(nid)) nodeMap.set(nid, []);
      nodeMap.get(nid)!.push(a);
    }

    const embed = new EmbedBuilder()
      .setTitle('🤖 Bot Network Overview')
      .setColor(0x3b82f6)
      .setDescription(
        `Total: **${allAccounts.length}** bots across **${nodeMap.size}** node(s)\nTip: Type \`,list <node-id>\` (e.g. \`,list 2\`) to view specific node bots.`
      )
      .setTimestamp();

    if (nodeMap.size === 0) {
      embed.setDescription('*No bots registered in the system.*');
      return embed;
    }

    for (const [nid, botList] of nodeMap.entries()) {
      const onlineCount = botList.filter((b: any) => b.status === 'CONNECTED' || b.status === 'online').length;
      const preview = botList.slice(0, 8).map((b: any) => {
        const isOnline = b.status === 'CONNECTED' || b.status === 'online';
        const tag = b.gamertag || b.id;
        const ign = b.ign || `${floodgatePrefix}${tag}`;
        return `${isOnline ? '🟢' : '🔴'} **#${b.id}** (\`${ign}\`)`;
      }).join('\n');
      const more = botList.length > 8 ? `\n*...and ${botList.length - 8} more (use ,list ${nid.replace('node-', '')})*` : '';

      embed.addFields({
        name: `${nid.toUpperCase()} (${onlineCount}/${botList.length} online)`,
        value: preview + more || '*No bots*',
        inline: false,
      });
    }

    return embed;
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

