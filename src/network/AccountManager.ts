import EventEmitter from 'events';
import { AppConfig, AccountConfig } from '../config';
import { BedrockBot, ConnectionState, MsaCodeData } from './BedrockBot';
import { ActionStates } from '../features/ActionController';
import { JoinScheduler } from './JoinScheduler';
import { TokenStorage } from '../auth/TokenStorage';
import { logger } from '../utils/logger';
import {
  getAccountsForNode,
  upsertAccount,
  deleteAccount,
  getPendingCommands,
  markCommandDone,
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
  private appConfig: AppConfig;
  private joinScheduler: JoinScheduler;
  private bots: Map<string, BedrockBot> = new Map();
  private statusSyncTimer: NodeJS.Timer | null = null;
  private commandPollTimer: NodeJS.Timer | null = null;
  private addingAccounts: Set<string> = new Set();

  constructor(appConfig: AppConfig) {
    super();
    this.appConfig = appConfig;
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

    for (const row of rows) {
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

  private async instantiateBot(accountConfig: AccountConfig): Promise<BedrockBot> {
    if (this.bots.has(accountConfig.id)) {
      return this.bots.get(accountConfig.id)!;
    }

    // Download tokens from Supabase to temp dir so prismarine-auth works
    const profilesFolder = await TokenStorage.ensureProfilesFolder(accountConfig.id);
    accountConfig.profilesFolder = profilesFolder;

    const bot = new BedrockBot(accountConfig, this.appConfig, null as any);
    this.bots.set(accountConfig.id, bot);

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
   * Removes an account permanently — stops the bot, clears tokens, deletes Supabase row.
   */
  public async removeAccount(accountId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    this.joinScheduler.cancelJoin(accountId);

    if (bot) {
      try { await bot.dispose(); } catch {}
      this.bots.delete(accountId);
    }

    await TokenStorage.clearTokens(accountId);

    // Only update Supabase to prevent auto-connect — do NOT delete the row
    // so other nodes (master/workers) keep their own bot instances intact.
    await upsertAccount({ id: accountId, node_id: this.appConfig.nodeId, auto_connect: false });

    this.emit('accountRemoved', accountId, bot?.xboxUsername);
    logger.info(`Account '${accountId}' removed from this node (Supabase row preserved)`);
    return true;
  }

  /**
   * Permanently deletes an account from Supabase entirely (all nodes lose it).
   * Used only by the master's /removebot Discord command.
   */
  public async forceRemoveAccount(accountId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    this.joinScheduler.cancelJoin(accountId);

    if (bot) {
      try { await bot.dispose(); } catch {}
      this.bots.delete(accountId);
    }

    await TokenStorage.clearTokens(accountId);
    await deleteAccount(accountId);

    this.emit('accountRemoved', accountId, bot?.xboxUsername);
    logger.info(`Account '${accountId}' permanently deleted from Supabase`);
    return true;
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
   * Stops the bot on this node, updates Supabase node_id, and cleans up local state.
   * The target node will pick up the account on its next load cycle.
   */
  public async moveAccount(accountId: string, targetNodeId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    this.joinScheduler.cancelJoin(accountId);

    if (bot) {
      try { await bot.dispose(); } catch {}
      this.bots.delete(accountId);
    }

    await TokenStorage.clearTokens(accountId);
    await upsertAccount({
      id: accountId,
      node_id: targetNodeId,
      auto_connect: true,
    });

    this.emit('accountRemoved', accountId, bot?.xboxUsername);
    logger.info(`Account '${accountId}' moved to node '${targetNodeId}'`, accountId);
    return true;
  }

  public async signOutAccount(accountId: string): Promise<boolean> {
    const bot = this.bots.get(accountId);
    if (!bot) return false;
    this.joinScheduler.cancelJoin(accountId);
    await bot.disconnect();
    await TokenStorage.clearTokens(accountId);
    bot.clearAuthToken();
    await upsertAccount({ id: accountId, node_id: this.appConfig.nodeId, auto_connect: false });
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
      await bot.disconnect();
      await upsertAccount({ id: accountId, node_id: this.appConfig.nodeId, auto_connect: false });
    }
  }

  public async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.bots.values()).map(b => b.disconnect()));
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
    for (const [id, bot] of this.bots.entries()) {
      try {
        const pos = bot.currentPosition;
        const authIdent = bot.authManager?.getIdentity?.() || null;
        await upsertAccount({
          id,
          node_id: this.appConfig.nodeId,
          status: bot.getState(),
          ign: bot.inGameIgn || '',
          gamertag: bot.xboxUsername || '',
          health: (bot as any).currentHealth ?? 20,
          pos_x: pos.x,
          pos_y: pos.y,
          pos_z: pos.z,
          afk_spot_active: bot.afkSpotTracker.isActive(),
          afk_spot: bot.afkSpotTracker.getSavedSpot(),
          msa_code: bot.msaCodeData?.user_code ?? null,
          msa_url: bot.msaCodeData?.verification_uri ?? null,
          msa_direct_url: bot.msaCodeData?.direct_verification_uri ?? null,
          auth_status: authIdent?.status || 'IDLE',
          auth_error: bot.authErrorMessage ?? null,
        });
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
    logger.info(`Executing command: ${action}${account_id ? ` [${account_id}]` : ''}`);

    switch (action) {
      case 'CONNECT':
        if (account_id) this.scheduleAccountConnect(account_id);
        break;

      case 'DISCONNECT':
        if (account_id) await this.disconnectAccount(account_id);
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

      case 'BOT_ACTION':
        if (account_id && payload.action) {
          this.executeBotAction(account_id, payload.action, payload.state, payload.options);
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
        isAfkSpotActive: bot.afkSpotTracker.isActive(),
        isAfkPaused: bot.afkSpotTracker.isMonitoringPaused(),
        afkSpot: bot.afkSpotTracker.getSavedSpot(),
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
        case 'toggle_jump':        res = ctrl.toggleJump(state); break;
        case 'toggle_left_click':  res = ctrl.toggleLeftClick(state); break;
        case 'toggle_right_click': res = ctrl.toggleRightClick(state); break;
        case 'throw_pearl':        res = ctrl.throwPearl(); break;
        case 'throw_item':         res = ctrl.throwItem(); break;
        case 'throw_all':          res = ctrl.throwAll(); break;
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
    if (action === 'throw_item' && results.every(r => r.state === false)) {
      return { success: false, error: 'Hand is empty — nothing to throw.', result: results };
    }
    if (action === 'throw_all' && results.every(r => r.state === false)) {
      return { success: false, error: 'Inventory is empty — nothing to throw.', result: results };
    }
    return { success: true, result: results };
  }

  public setAfkSpot(accountId: string): { success: boolean; afkSpot?: any; error?: string } {
    const bot = this.getBot(accountId);
    if (!bot) return { success: false, error: `No active bot matching '${accountId}'` };
    if (bot.getState() !== ConnectionState.CONNECTED) return { success: false, error: `Bot '${accountId}' is not connected.` };
    if (bot.afkSpotTracker.isActive()) return { success: false, error: `Bot '${accountId}' already has an AFK spot. Use Reset instead.` };
    bot.afkSpotTracker.activateAfkMode();
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
