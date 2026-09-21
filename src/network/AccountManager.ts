import EventEmitter from 'events';
import { AppConfig, AccountConfig } from '../config';
import { BedrockBot, ConnectionState, MsaCodeData } from './BedrockBot';
import { ActionStates } from '../features/ActionController';
import { JoinScheduler } from './JoinScheduler';
import { TokenStorage } from '../auth/TokenStorage';
import { logger } from '../utils/logger';
import { NotificationService } from '../notify/NotificationService';
import { LocationStorage } from '../storage/LocationStorage';
import { PersistentActionStorage } from '../storage/PersistentActionStorage';
import {
  getAccountsForNode,
  getAccountById,
  upsertAccount,
  updateAccountFields,
  deleteAccount,
  getPendingCommands,
  markCommandDone,
  insertCommand,
} from '../database/SupabaseClient';

export interface AccountStatusSummary {
  accountId: string;
  xboxUsername: string;
  state: ConnectionState;
  authStatus?: string;
  xuid?: string | null;
  xboxProfileSetupUrl?: string | null;
  position: string;
  authErrorMessage: string | null;
  msaCodeData: MsaCodeData | null;
  inGameIgn: string;
  isAfkSpotActive: boolean;
  isAfkPaused: boolean;
  afkSpot: { x: number; y: number; z: number } | null;
  actionStates?: ActionStates;
}

export class AccountManager extends EventEmitter {
  private static knownBotNames: Set<string> = new Set();
  private static knownBotRuntimeIds: Set<string> = new Set();

  public static registerBotName(name?: string | null): void {
    if (!name) return;
    const clean = name.trim().toLowerCase();
    if (!clean) return;
    AccountManager.knownBotNames.add(clean);
    const stripped = clean.replace(/^[._*]+/, '');
    if (stripped) {
      AccountManager.knownBotNames.add(stripped);
    }
  }

  public static registerBotRuntimeId(id?: bigint | number | string | null): void {
    if (id == null) return;
    const str = String(id);
    if (str && str !== '0') {
      AccountManager.knownBotRuntimeIds.add(str);
    }
  }

  public static isKnownBot(name?: string | null, runtimeId?: bigint | number | string | null): boolean {
    if (runtimeId != null) {
      const str = String(runtimeId);
      if (str && str !== '0' && AccountManager.knownBotRuntimeIds.has(str)) {
        return true;
      }
    }

    if (name) {
      const clean = name.trim().toLowerCase();
      if (!clean) return false;
      if (AccountManager.knownBotNames.has(clean)) return true;
      const stripped = clean.replace(/^[._*]+/, '');
      if (stripped && AccountManager.knownBotNames.has(stripped)) return true;
      for (const known of AccountManager.knownBotNames) {
        const knownStripped = known.replace(/^[._*]+/, '');
        if (knownStripped && (knownStripped === stripped || known === clean)) return true;
      }
    }
    return false;
  }

  private appConfig: AppConfig;
  private notificationService: NotificationService;
  private joinScheduler: JoinScheduler;
  private bots: Map<string, BedrockBot> = new Map();
  private statusSyncTimer: NodeJS.Timer | null = null;
  private commandPollTimer: NodeJS.Timer | null = null;
  private addingAccounts: Set<string> = new Set();
  private lastPushedTelemetry: Map<string, { fingerprint: string; timestamp: number }> = new Map();
  private lastReconciliationTime: number = 0;

  constructor(appConfig: AppConfig) {
    super();
    this.appConfig = appConfig;
    this.notificationService = new NotificationService((appConfig as any).notification?.endpoint || '');
    this.joinScheduler = new JoinScheduler(
      appConfig.joinScheduler.minDelayMs,
      appConfig.joinScheduler.maxDelayMs
    );
  }

  /**
   * Loads accounts assigned to this node from Supabase and instantiates bots.
   */
  public async loadAccountsFromSupabase(): Promise<void> {
    const rows = await getAccountsForNode(this.appConfig.nodeId);
    logger.info(`Found ${rows.length} account(s) in Supabase for node '${this.appConfig.nodeId}'`);
    LocationStorage.populateFromSupabase(rows);
    PersistentActionStorage.populateFromSupabase(rows);

    for (const row of rows) {
      AccountManager.registerBotName(row.id);
      if (row.ign) AccountManager.registerBotName(row.ign);
      if (row.gamertag) AccountManager.registerBotName(row.gamertag);
      try {
        if (!this.bots.has(row.id)) {
          await this.instantiateBot({
            id: row.id,
            email: row.email || '',
            nodeId: this.appConfig.nodeId,
            autoConnect: row.auto_connect ?? true,
            offline: row.offline_mode ?? false,
            profilesFolder: '',
          });
        }
      } catch (err: any) {
        logger.error(`Failed to load account '${row.id}': ${err.message}`, row.id);
      }
    }
  }

  /**
   * Loads a specific account from Supabase, restores its tokens to disk, and instantiates the bot.
   */
  public async loadAccountFromSupabase(accountId: string): Promise<BedrockBot | null> {
    try {
      const row = await getAccountById(accountId);
      if (!row) {
        logger.warn(`Cannot load account '${accountId}' from Supabase: record not found`, accountId);
        return null;
      }

      // Download / ensure tokens from Supabase are written to disk
      await TokenStorage.ensureProfilesFolder(accountId);

      AccountManager.registerBotName(row.id);
      if (row.ign) AccountManager.registerBotName(row.ign);
      if (row.gamertag) AccountManager.registerBotName(row.gamertag);

      let bot = this.bots.get(accountId);
      if (!bot) {
        bot = await this.instantiateBot({
          id: row.id,
          email: row.email || '',
          nodeId: this.appConfig.nodeId,
          autoConnect: row.auto_connect ?? true,
          offline: row.offline_mode ?? false,
          profilesFolder: '',
        });
      }
      return bot;
    } catch (err: any) {
      logger.error(`loadAccountFromSupabase failed for '${accountId}': ${err?.message}`, accountId);
      return null;
    }
  }

  public async instantiateBot(accountConfig: AccountConfig): Promise<BedrockBot> {
    if (this.bots.has(accountConfig.id)) {
      return this.bots.get(accountConfig.id)!;
    }

    // Download tokens from Supabase to temp dir so prismarine-auth works
    const profilesFolder = await TokenStorage.ensureProfilesFolder(accountConfig.id);
    accountConfig.profilesFolder = profilesFolder;

    const bot = new BedrockBot(accountConfig, this.appConfig, this.notificationService);
    this.bots.set(accountConfig.id, bot);

    // Stagger watchdog reconnect attempts through JoinScheduler to prevent concurrent Microsoft auth rate-limits
    bot.setReconnectScheduler((task: () => Promise<void>) => {
      return this.joinScheduler.scheduleJoin(bot.accountId, task);
    });

    // After any successful auth, sync new token to Supabase
    bot.on('authenticated', () => {
      TokenStorage.syncToSupabase(accountConfig.id, this.appConfig.nodeId).catch(() => {});
    });

    // Also sync when bot fully connects (cached tokens may not trigger 'authenticated')
    bot.on('stateChanged', (newState: string) => {
      if (newState === 'CONNECTED') {
        TokenStorage.syncToSupabase(accountConfig.id, this.appConfig.nodeId).catch(() => {});
      }
    });

    logger.info(`Registered account '${accountConfig.id}'`, accountConfig.id);
    this.emit('accountAdded', bot);
    return bot;
  }

  /**
   * Creates a new account in Supabase and starts the bot.
   */
  public async addAccount(id: string, email: string): Promise<BedrockBot> {
    const trimId = id.trim();
    const trimEmail = email.trim();

    // Prevent duplicate add operations for the same account
    if (this.addingAccounts.has(trimId)) {
      const existing = this.bots.get(trimId);
      if (existing) return existing;
    }
    this.addingAccounts.add(trimId);

    try {
      // Check if account identifier already exists on ANY node in Supabase
      const existingRow = await getAccountById(trimId);
      if (existingRow && existingRow.node_id !== this.appConfig.nodeId) {
        throw new Error(`Account Identifier '#${trimId}' is already in use by node '${existingRow.node_id}'. Please use a unique identifier.`);
      }

      // Double-check after acquiring lock
      const existing = this.bots.get(trimId);
      if (existing) return existing;

      await upsertAccount({
        id: trimId,
        node_id: this.appConfig.nodeId,
        email: trimEmail,
        auto_connect: true,
      });

      const accConfig: AccountConfig = {
        id: trimId,
        email: trimEmail,
        nodeId: this.appConfig.nodeId,
        autoConnect: true,
        offline: false,
        profilesFolder: '',
      };

      const bot = await this.instantiateBot(accConfig);
      logger.info(`Added new account '${trimId}' (${trimEmail})`, trimId);
      return bot;
    } finally {
      this.addingAccounts.delete(trimId);
    }
  }

  /**
   * Removes an account permanently — stops the bot, clears tokens, deletes Supabase row,
   * clears saved location, and signals Discord channel deletion.
   */
  public async removeAccount(accountId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    const xboxUsername = bot?.xboxUsername;
    this.joinScheduler.cancelJoin(accountId);

    if (bot) {
      try {
        await bot.dispose();
      } catch (err: any) {
        logger.warn(`Error during bot.dispose() for '${accountId}': ${err?.message}`);
      }
      let waitCount = 0;
      while (bot.getState() !== ConnectionState.DISCONNECTED && waitCount < 15) {
        await new Promise(res => setTimeout(res, 100));
        waitCount++;
      }
      this.bots.delete(accountId);
    } else {
      // Check if account is active on a remote node and command clean disconnection first
      try {
        const accRow = await getAccountById(accountId);
        if (accRow && accRow.node_id && accRow.node_id !== this.appConfig.nodeId) {
          await insertCommand(accRow.node_id, accountId, 'SAFE_DISCONNECT_ACCOUNT', { accountId });
          await new Promise(res => setTimeout(res, 1500));
        }
      } catch (err: any) {
        logger.debug(`Remote disconnect check failed for '${accountId}': ${err?.message}`);
      }
    }

    await TokenStorage.clearTokens(accountId);
    await LocationStorage.setAfkSpot(accountId, this.appConfig.nodeId, null);

    // Permanently delete from Supabase so database row is removed
    await deleteAccount(accountId);

    // If on worker node, send command to master node to immediately delete Discord channel
    if (!this.appConfig.discord.isMaster) {
      try {
        await insertCommand('node-1', accountId, 'DELETE_DISCORD_CHANNEL', { accountId, xboxUsername });
      } catch (err: any) {
        logger.debug(`Could not queue DELETE_DISCORD_CHANNEL to master: ${err?.message}`);
      }
    }

    this.emit('accountRemoved', accountId, xboxUsername);
    logger.info(`Account '${accountId}' cleanly disconnected and permanently removed from database`);
    return true;
  }

  /**
   * Permanently deletes an account from Supabase entirely (all nodes lose it).
   * Used only by the master's /removebot Discord command.
   */
  public async forceRemoveAccount(accountId: string): Promise<boolean> {
    return this.removeAccount(accountId);
  }

  public async clearAccountAuthAndRetry(accountId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    if (!bot) return false;
    await bot.disconnect();
    await TokenStorage.clearTokens(accountId);
    bot.clearAuthToken();
    return this.scheduleAccountConnect(accountId);
  }

  /**
   * Moves an account to a different node.
   * Completely disconnects the bot first, confirms offline state, transfers tokens,
   * updates Supabase node_id, and notifies target node.
   */
  public async moveAccount(accountId: string, targetNodeId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    this.joinScheduler.cancelJoin(accountId);

    if (bot) {
      try {
        await bot.dispose();
      } catch (err: any) {
        logger.warn(`Error during bot.dispose() for move '${accountId}': ${err?.message}`);
      }
      let waitCount = 0;
      while (bot.getState() !== ConnectionState.DISCONNECTED && waitCount < 15) {
        await new Promise(res => setTimeout(res, 100));
        waitCount++;
      }
      this.bots.delete(accountId);
    } else {
      // If hosted on another node, signal that node to cleanly disconnect before moving
      try {
        const accRow = await getAccountById(accountId);
        if (accRow && accRow.node_id && accRow.node_id !== this.appConfig.nodeId) {
          await insertCommand(accRow.node_id, accountId, 'SAFE_DISCONNECT_ACCOUNT', { accountId });
          await new Promise(res => setTimeout(res, 1500));
        }
      } catch (err: any) {
        logger.debug(`Remote disconnect check for move failed for '${accountId}': ${err?.message}`);
      }
    }

    // Transfer tokens to target node
    await TokenStorage.transferTokens(accountId, targetNodeId);
    await updateAccountFields(accountId, {
      node_id: targetNodeId,
      auto_connect: true,
      status: 'CONNECTING',
    });

    // Notify target node immediately via command bus
    try {
      await insertCommand(targetNodeId, accountId, 'LOAD_AND_CONNECT', { accountId });
    } catch (err: any) {
      logger.debug(`Could not send LOAD_AND_CONNECT command to ${targetNodeId}: ${err?.message}`);
    }

    this.emit('accountRemoved', accountId, bot?.xboxUsername);
    logger.info(`Account '${accountId}' cleanly disconnected and moved to node '${targetNodeId}'`, accountId);
    return true;
  }

  public async signOutAccount(accountId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    if (!bot) return false;
    this.joinScheduler.cancelJoin(accountId);
    await bot.disconnect();
    await TokenStorage.clearTokens(accountId);
    bot.clearAuthToken();
    await updateAccountFields(accountId, { node_id: this.appConfig.nodeId, auto_connect: false });
    logger.info(`Account '${accountId}' signed out`, accountId);
    return true;
  }

  public connectAutoConnectAccounts(): void {
    for (const [id, bot] of this.bots.entries()) {
      if (bot.autoConnect !== false) {
        this.scheduleAccountConnect(id);
      }
    }
  }

  public scheduleAccountConnect(accountId: string): boolean {
    const bot = this.bots.get(accountId);
    if (!bot) { logger.warn(`Cannot connect '${accountId}': not registered`); return false; }
    bot.autoConnect = true;
    updateAccountFields(accountId, { node_id: this.appConfig.nodeId, auto_connect: true }).catch(() => {});
    const state = bot.getState();
    if (state === ConnectionState.CONNECTED) return false;
    // If stuck in CONNECTING from a timed-out join, force disconnect first
    if (state === ConnectionState.CONNECTING || state === ConnectionState.RECONNECTING) {
      logger.info(`Force-resetting stuck connection for '${accountId}'`, accountId);
      bot.disconnect().catch(() => {});
    }
    return this.joinScheduler.scheduleJoin(accountId, async () => { await bot.connect(); });
  }

  public async disconnectAccount(accountId: string): Promise<void> {
    const bot = this.bots.get(accountId);
    if (bot) {
      this.joinScheduler.cancelJoin(accountId);
      bot.autoConnect = false;
      await bot.disconnect();
      await updateAccountFields(accountId, { node_id: this.appConfig.nodeId, auto_connect: false }).catch(() => {});
    }
  }

  public async disconnectAll(): Promise<number> {
    const list = Array.from(this.bots.values());
    for (const b of list) {
      this.joinScheduler.cancelJoin(b.accountId);
      b.autoConnect = false;
      await b.disconnect();
      await updateAccountFields(b.accountId, { node_id: this.appConfig.nodeId, auto_connect: false }).catch(() => {});
    }
    return list.length;
  }

  public connectAll(): number {
    let count = 0;
    for (const [id, bot] of this.bots.entries()) {
      if (bot.getState() !== ConnectionState.CONNECTED && bot.getState() !== ConnectionState.CONNECTING) {
        bot.autoConnect = true;
        updateAccountFields(id, { node_id: this.appConfig.nodeId, auto_connect: true }).catch(() => {});
        this.scheduleAccountConnect(id);
        count++;
      }
    }
    return count;
  }

  // ─── Status Push to Supabase ─────────────────────────────────────────────────

  public startStatusSync(intervalMs = 5000): void {
    if (this.statusSyncTimer) return;
    this.statusSyncTimer = setInterval(() => this.pushStatus(), intervalMs);
    logger.info(`Status sync started (every ${intervalMs / 1000}s)`);
  }

  public stopStatusSync(): void {
    if (this.statusSyncTimer) { clearInterval(this.statusSyncTimer as any); this.statusSyncTimer = null; }
  }

  private async pushStatus(): Promise<void> {
    const now = Date.now();

    // 1. Reconcile accounts: auto-load any account moved/assigned to this node, unload any moved away
    // Throttled to run at most once every 60 seconds to prevent Supabase request flooding
    if (now - this.lastReconciliationTime >= 60000) {
      this.lastReconciliationTime = now;
      try {
        const assignedRows = await getAccountsForNode(this.appConfig.nodeId);
        const assignedIds = new Set(assignedRows.map(r => r.id));

        for (const row of assignedRows) {
          if (!this.bots.has(row.id)) {
            logger.info(`Auto-loading newly assigned account '${row.id}' for node '${this.appConfig.nodeId}'`, row.id);
            await this.instantiateBot({
              id: row.id,
              email: row.email || '',
              nodeId: this.appConfig.nodeId,
              autoConnect: row.auto_connect === true,
              offline: row.offline_mode ?? false,
              profilesFolder: '',
            });
            if (row.auto_connect === true) {
              this.scheduleAccountConnect(row.id);
            }
          }
        }

        for (const [id, bot] of this.bots.entries()) {
          if (!assignedIds.has(id)) {
            logger.info(`Account '${id}' no longer assigned to node '${this.appConfig.nodeId}'. Unloading...`, id);
            this.joinScheduler.cancelJoin(id);
            try { await bot.dispose(); } catch {}
            this.bots.delete(id);
            this.lastPushedTelemetry.delete(id);
          }
        }
      } catch (err: any) {
        logger.debug(`Account reconciliation: ${err?.message}`);
      }
    }

    // 2. Push telemetry for all active bots with diff-based change detection
    for (const [id, bot] of this.bots.entries()) {
      try {
        const pos = bot.currentPosition;
        const authIdent = bot.authManager?.getIdentity?.() || null;
        const state = bot.getState();
        const ign = bot.inGameIgn || '';
        const gamertag = bot.xboxUsername || '';
        const health = (bot as any).currentHealth ?? 20;
        const roundedX = Math.round(pos.x);
        const roundedY = Math.round(pos.y);
        const roundedZ = Math.round(pos.z);
        const savedSpot = bot.afkSpotTracker.getSavedSpot() || LocationStorage.getLocation(id);
        const isAfkActive = savedSpot !== null && (bot.afkSpotTracker.isActive() || state === ConnectionState.CONNECTED) && !bot.afkSpotTracker.isMonitoringPaused();
        const msaCode = bot.msaCodeData?.user_code ?? null;
        const authStatus = authIdent?.status || 'IDLE';
        const authError = bot.authErrorMessage ?? null;

        AccountManager.registerBotName(id);
        if (ign) AccountManager.registerBotName(ign);
        if (gamertag) AccountManager.registerBotName(gamertag);
        if (bot.runtimeEntityId) AccountManager.registerBotRuntimeId(bot.runtimeEntityId);

        // Build telemetry fingerprint
        const fingerprint = `${state}|${ign}|${gamertag}|${health}|${roundedX},${roundedY},${roundedZ}|${isAfkActive}|${msaCode}|${authStatus}|${authError}`;

        const cached = this.lastPushedTelemetry.get(id);
        // Skip updating Supabase if telemetry has not changed and last push was within 60 seconds
        if (cached && cached.fingerprint === fingerprint && (now - cached.timestamp < 60000)) {
          continue;
        }

        await updateAccountFields(id, {
          node_id: this.appConfig.nodeId,
          status: state,
          ign: ign,
          gamertag: gamertag,
          health: health,
          pos_x: pos.x,
          pos_y: pos.y,
          pos_z: pos.z,
          afk_spot_active: isAfkActive,
          afk_spot: savedSpot,
          msa_code: msaCode,
          msa_url: bot.msaCodeData?.verification_uri ?? null,
          msa_direct_url: bot.msaCodeData?.direct_verification_uri ?? null,
          auth_status: authStatus,
          auth_error: authError,
        });

        this.lastPushedTelemetry.set(id, { fingerprint, timestamp: now });
      } catch (err: any) {
        logger.debug(`Status sync [${id}]: ${err?.message}`);
      }
    }
  }

  // ─── Command Polling ─────────────────────────────────────────────────────────

  public startCommandPolling(intervalMs = 2000): void {
    if (this.commandPollTimer) return;
    this.commandPollTimer = setInterval(() => this.pollCommands(), intervalMs);
    logger.info(`Command polling started (every ${intervalMs / 1000}s)`);
  }

  public stopCommandPolling(): void {
    if (this.commandPollTimer) { clearInterval(this.commandPollTimer as any); this.commandPollTimer = null; }
  }

  private async pollCommands(): Promise<void> {
    let commands: any[];
    try {
      commands = await getPendingCommands(this.appConfig.nodeId);
    } catch { return; }

    for (const cmd of commands) {
      try {
        await this.executeCommand(cmd);
        await markCommandDone(cmd.id, 'DONE');
      } catch (err: any) {
        logger.warn(`Command [${cmd.action}] failed: ${err?.message}`);
        await markCommandDone(cmd.id, 'FAILED').catch(() => {});
      }
    }
  }

  private async executeCommand(cmd: { action: string; account_id?: string; payload: any }): Promise<void> {
    const { action, account_id, payload = {} } = cmd;
    if (action !== 'DISCORD_LOG' && action !== 'REGISTER_NODE_CATEGORY') {
      logger.debug(`Executing command: ${action}${account_id ? ` [${account_id}]` : ''}`);
    }

    switch (action) {
      case 'LOAD_AND_CONNECT':
      case 'CONNECT':
        if (account_id) {
          if (!this.bots.has(account_id)) {
            await this.loadAccountFromSupabase(account_id);
          }
          this.scheduleAccountConnect(account_id);
        }
        break;

      case 'DISCONNECT':
        if (account_id) await this.disconnectAccount(account_id);
        break;

      case 'CONNECT_ALL':
        logger.info(`Received CONNECT_ALL command for node '${this.appConfig.nodeId}'`);
        this.connectAll();
        break;

      case 'DISCONNECT_ALL':
        logger.info(`Received DISCONNECT_ALL command for node '${this.appConfig.nodeId}'`);
        await this.disconnectAll();
        break;

      case 'CHAT':
        if (account_id && payload.message) this.sendBotChat(account_id, payload.message);
        break;

      case 'CLEAR_AUTH':
        if (account_id) await this.clearAccountAuthAndRetry(account_id);
        break;

      case 'RETRY_PROFILE':
        if (account_id) {
          const bot = this.bots.get(account_id);
          if (bot) await bot.authManager?.retryProfileCheck?.();
        }
        break;

      case 'SET_AFK':
        if (account_id) this.setAfkSpot(account_id);
        break;

      case 'RESET_AFK':
        if (account_id) this.resetAfkSpot(account_id);
        break;

      case 'TOGGLE_AFK_MONITOR':
        if (account_id) this.toggleAfkMonitor(account_id);
        break;

      case 'BOT_ACTION': {
        const targetId = account_id || payload?.accountId || payload?.account_id || 'all';
        const targetAction = payload?.action;
        if (targetAction) {
          this.executeBotAction(targetId, targetAction, payload?.state, payload?.options);
        }
        break;
      }

      case 'REGISTER_NODE_CATEGORY':
        if (payload?.nodeId && payload?.categoryId) {
          this.emit('registerNodeCategory', payload.nodeId, payload.categoryId);
        }
        break;

      case 'ADD_ACCOUNT':
        if (payload.id && payload.email) {
          await this.addAccount(payload.id, payload.email);
          if (payload.auto_connect !== false) this.scheduleAccountConnect(payload.id);
        }
        break;

      case 'MOVE_ACCOUNT':
        if (account_id && payload.targetNodeId) {
          await this.moveAccount(account_id, payload.targetNodeId);
        }
        break;

      case 'REMOVE_ACCOUNT':
        if (account_id) await this.removeAccount(account_id);
        break;

      case 'SAFE_DISCONNECT_ACCOUNT':
        if (account_id) {
          this.joinScheduler.cancelJoin(account_id);
          const bot = this.bots.get(account_id);
          if (bot) {
            try { await bot.dispose(); } catch {}
            this.bots.delete(account_id);
          }
          await updateAccountFields(account_id, { auto_connect: false, status: 'DISCONNECTED' }).catch(() => {});
          logger.info(`Cleanly disconnected and disposed bot '${account_id}' per SAFE_DISCONNECT_ACCOUNT`, account_id);
        }
        break;

      case 'DISCONNECT_ALL':
        await this.disconnectAll();
        logger.info('Cleanly disconnected all local bots per DISCONNECT_ALL command');
        break;

      case 'DELETE_DISCORD_CHANNEL':
        this.emit('accountRemoved', account_id, payload?.xboxUsername);
        break;

      case 'DISCORD_LOG':
        if (payload?.type) {
          try {
            const { discordLogger } = require('../discord/DiscordLogger');
            if (payload.type === 'join') {
              await discordLogger.logBotJoin(payload.botName, payload.ign, payload.serverHost);
            } else if (payload.type === 'leave') {
              await discordLogger.logBotLeft(payload.botName, payload.ign, payload.reason);
            } else if (payload.type === 'afk') {
              await discordLogger.logAfkActivity(payload.botName, payload.message);
            } else if (payload.type === 'player_detected') {
              await discordLogger.logPlayerDetected(payload.botName, payload.playerName, payload.distance, payload.posStr);
            }
          } catch (err: any) {
            logger.debug(`DISCORD_LOG processing failed: ${err?.message}`);
          }
        }
        break;

      case 'SIGNOUT':
        if (account_id) await this.signOutAccount(account_id);
        break;

      default:
        logger.warn(`Unknown command action: ${action}`);
    }
  }

  // ─── Status Summary ──────────────────────────────────────────────────────────

  public getStatusSummary(): AccountStatusSummary[] {
    const summary: AccountStatusSummary[] = [];
    for (const [id, bot] of this.bots.entries()) {
      const pos = bot.currentPosition;
      const authIdent = bot.authManager?.getIdentity?.() || null;
      const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
      const xboxName = bot.xboxUsername || id;
      const savedSpot = bot.afkSpotTracker.getSavedSpot() || LocationStorage.getLocation(id);
      summary.push({
        accountId: id,
        xboxUsername: xboxName,
        state: bot.getState(),
        authStatus: authIdent?.status || 'IDLE',
        xuid: authIdent?.xuid || null,
        xboxProfileSetupUrl: authIdent?.setupUrl || null,
        position: `X ${Math.round(pos.x)}, Y ${Math.round(pos.y)}, Z ${Math.round(pos.z)}`,
        authErrorMessage: bot.authErrorMessage,
        msaCodeData: bot.msaCodeData,
        inGameIgn: bot.inGameIgn || `${floodgatePrefix}${xboxName}`,
        isAfkSpotActive: savedSpot !== null && bot.afkSpotTracker.isActive(),
        isAfkPaused: bot.afkSpotTracker.isMonitoringPaused(),
        afkSpot: savedSpot,
        actionStates: bot.actionController.getStates(),
      });
    }
    return summary;
  }

  // ─── Bot Actions ─────────────────────────────────────────────────────────────

  public executeBotAction(
    accountId: string,
    action: string,
    state?: boolean,
    options?: { minDelay?: number; maxDelay?: number; degrees?: number; distance?: number }
  ): { success: boolean; result?: any; error?: string } {
    const targets = accountId === 'all'
      ? Array.from(this.bots.values())
      : [this.getBot(accountId)].filter((b): b is BedrockBot => Boolean(b));

    if (targets.length === 0) return { success: false, error: `No active bot matching '${accountId}'` };

    const results: any[] = [];
    for (const bot of targets) {
      const ctrl = bot.actionController;
      let res: any;
      switch (action) {
        case 'toggle_crouch':      res = ctrl.toggleCrouch(state); break;
        case 'jump':               res = ctrl.jump(); break;
        case 'toggle_jump':        res = ctrl.toggleJump(state); break;
        case 'toggle_left_click':  res = ctrl.toggleLeftClick(state); break;
        case 'toggle_right_click': res = ctrl.toggleRightClick(state); break;
        case 'throw_pearl':        res = ctrl.throwPearl(); break;
        case 'toggle_spam_click':  res = ctrl.toggleSpamClick(state, options?.minDelay, options?.maxDelay); break;
        case 'look_up':    ctrl.look('up',    options?.degrees ?? 15); res = true; break;
        case 'look_down':  ctrl.look('down',  options?.degrees ?? 15); res = true; break;
        case 'look_left':  ctrl.look('left',  options?.degrees ?? 15); res = true; break;
        case 'look_right': ctrl.look('right', options?.degrees ?? 15); res = true; break;
        default: return { success: false, error: `Unknown action '${action}'` };
      }
      results.push({ accountId: bot.accountId, state: res, states: ctrl.getStates() });
    }

    if (action === 'throw_pearl' && results.every(r => r.state === false)) {
      return { success: false, error: 'No ender pearl found in hotbar (slots 1-9).', result: results };
    }
    return { success: true, result: results };
  }

  public setAfkSpot(accountId: string): { success: boolean; afkSpot?: any; error?: string } {
    const bot = this.getBot(accountId);
    if (!bot) return { success: false, error: `No active bot matching '${accountId}'` };
    if (bot.getState() !== ConnectionState.CONNECTED) return { success: false, error: `Bot '${accountId}' is not connected.` };
    if (bot.afkSpotTracker.isActive() || bot.afkSpotTracker.getSavedSpot()) {
      bot.afkSpotTracker.resetAfkLocation();
    } else {
      bot.afkSpotTracker.activateAfkMode();
    }
    return { success: true, afkSpot: bot.afkSpotTracker.getSavedSpot() };
  }

  public resetAfkSpot(accountId: string): { success: boolean; afkSpot?: any; error?: string } {
    const bot = this.getBot(accountId);
    if (!bot) return { success: false, error: `No active bot matching '${accountId}'` };
    if (bot.getState() !== ConnectionState.CONNECTED) return { success: false, error: `Bot '${accountId}' is not connected.` };
    bot.afkSpotTracker.resetAfkLocation();
    return { success: true, afkSpot: bot.afkSpotTracker.getSavedSpot() };
  }

  public toggleAfkMonitor(accountId: string): { success: boolean; isPaused?: boolean; error?: string } {
    const bot = this.getBot(accountId);
    if (!bot) return { success: false, error: `No active bot matching '${accountId}'` };
    if (!bot.afkSpotTracker.isActive()) return { success: false, error: `Bot '${accountId}' has no AFK spot set.` };
    if (bot.afkSpotTracker.isMonitoringPaused()) bot.afkSpotTracker.resumeMonitoring();
    else bot.afkSpotTracker.pauseMonitoring();
    return { success: true, isPaused: bot.afkSpotTracker.isMonitoringPaused() };
  }

  public sendBotChat(accountId: string, message: string): { success: boolean; error?: string } {
    const targets = accountId === 'all'
      ? Array.from(this.bots.values())
      : [this.getBot(accountId)].filter((b): b is BedrockBot => Boolean(b));
    if (targets.length === 0) return { success: false, error: `No active bot matching '${accountId}'` };
    for (const bot of targets) bot.sendChat(message);
    return { success: true };
  }

  public getBot(query: string): BedrockBot | undefined {
    if (this.bots.has(query)) return this.bots.get(query);
    const norm = query.toLowerCase();
    for (const bot of this.bots.values()) {
      if (bot.accountId.toLowerCase() === norm || bot.xboxUsername?.toLowerCase() === norm) return bot;
    }
    return undefined;
  }

  public getAllBots(): BedrockBot[] { return Array.from(this.bots.values()); }
}
