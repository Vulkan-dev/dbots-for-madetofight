import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { AppConfig, applyNodeSettings } from '../config';
import { AccountManager } from '../network/AccountManager';
import { PermissionStorage } from '../storage/PermissionStorage';
import { IgnoreListStorage } from '../storage/IgnoreListStorage';
import { TokenStorage } from '../auth/TokenStorage';
import {
  upsertNodeSettings,
  getNodeSettings,
  insertCommand,
  getAllNodes,
  updateAccountFields,
  getAccountById,
  upsertAccount,
  getAccountsForNode,
  exportAllBackupData,
  importAllBackupData,
  syncToSecondarySupabase,
  loadFromSecondarySupabase,
  getLastSecondarySyncStatus,
  setAccountGroup,
  renameAccountGroup,
  ungroupAccounts,
  clearDatabaseTables,
} from '../database/SupabaseClient';
import { logger } from '../utils/logger';
import { discordLogger } from '../discord/DiscordLogger';

export class WebServer {
  private app: express.Application;
  private manager: AccountManager;
  private config: AppConfig;
  private port: number;
  private discordBot: any = null;

  public setDiscordBot(bot: any): void {
    this.discordBot = bot;
  }

  constructor(manager: AccountManager, config: AppConfig) {
    this.app = express();
    this.manager = manager;
    this.config = config;
    this.port = config.webServer.port;
    this.configureMiddleware();
    this.configureRoutes();
  }

  private configureMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));

    // CORS — normalize trailing slashes on both sides
    this.app.use((req, res, next) => {
      const origin = req.headers.origin || '';
      const normOrigin = origin.replace(/\/+$/, '');
      const allowedBase = this.config.webServer.frontendUrl === '*'
        ? '*'
        : this.config.webServer.frontendUrl.replace(/\/+$/, '');
      if (normOrigin && (allowedBase === '*' || normOrigin === allowedBase)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Api-Secret');
      if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
      next();
    });

    // Optional API secret validation (header only — no query param)
    this.app.use('/api/', (req, res, next) => {
      const secret = this.config.webServer.apiSecret;
      if (!secret) { next(); return; }
      const provided = req.headers['x-api-secret'];
      if (provided === secret) { next(); return; }
      res.status(401).json({ success: false, error: 'Unauthorized' });
    });
  }

  private configureRoutes(): void {
    // ── Health check ────────────────────────────────────────────────────────
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        nodeId: this.config.nodeId,
        nodeName: this.config.nodeName,
        uptime: process.uptime(),
        botCount: this.manager.getAllBots().length,
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        nodeId: this.config.nodeId,
        nodeName: this.config.nodeName,
        uptime: process.uptime(),
        botCount: this.manager.getAllBots().length,
        timestamp: new Date().toISOString(),
      });
    });

    // ── Status ──────────────────────────────────────────────────────────────
    this.app.get('/api/status', (_req, res) => {
      res.json({
        nodeId: this.config.nodeId,
        nodeName: this.config.nodeName,
        server: this.config.server,
        accounts: this.manager.getStatusSummary(),
      });
    });

    // ── All nodes ───────────────────────────────────────────────────────────
    this.app.get('/api/nodes', async (_req, res) => {
      try {
        const nodes = await getAllNodes();
        res.json({ nodes });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Add account ─────────────────────────────────────────────────────────
    this.app.post('/api/accounts/add', async (req, res) => {
      const { id, email } = req.body;
      if (!id || typeof id !== 'string') {
        res.status(400).json({ success: false, error: 'Account ID is required' }); return;
      }
      if (!email || typeof email !== 'string') {
        res.status(400).json({ success: false, error: 'Email is required' }); return;
      }
      const trimId = id.trim();
      const existing = await getAccountById(trimId);
      if (existing && existing.node_id !== this.config.nodeId) {
        res.status(400).json({
          success: false,
          error: `Account Identifier '#${trimId}' is already in use by node '${existing.node_id}'. Please use a unique identifier.`
        });
        return;
      }
      if (this.manager.getBot(trimId)) {
        res.status(400).json({ success: false, error: `Account '#${trimId}' already exists on this node` }); return;
      }
      try {
        const bot = await this.manager.addAccount(trimId, email.trim());

        const codeInfo = await new Promise<any>((resolve) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) { resolved = true; bot.authManager.removeListener('msaCode', onCode); resolve(null); }
          }, 20000);
          const onCode = (data: any) => {
            if (!resolved) { resolved = true; clearTimeout(timeout); bot.authManager.removeListener('msaCode', onCode); resolve(data); }
          };
          bot.authManager.on('msaCode', onCode);
          this.manager.scheduleAccountConnect(trimId);
        });

        logger.info(`API: Added account '${trimId}'`);
        res.json({
          success: true,
          accountId: trimId,
          codeInfo: codeInfo ? {
            user_code: codeInfo.user_code,
            verification_uri: codeInfo.verification_uri,
            direct_verification_uri: codeInfo.direct_verification_uri,
          } : null,
        });
      } catch (err: any) {
        logger.error(`API: Failed to add account '${trimId}': ${err.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Quick link login ────────────────────────────────────────────────────
    this.app.post('/api/accounts/link', async (req, res) => {
      const { id, email } = req.body;
      if (!id || typeof id !== 'string') {
        res.status(400).json({ success: false, error: 'Account ID is required' }); return;
      }
      const trimId = id.trim();
      const existing = await getAccountById(trimId);
      if (existing && existing.node_id !== this.config.nodeId) {
        res.status(400).json({
          success: false,
          error: `Account Identifier '#${trimId}' is already in use by node '${existing.node_id}'. Please use a unique identifier.`
        });
        return;
      }
      if (this.manager.getBot(trimId)) {
        res.status(400).json({ success: false, error: `Account '#${trimId}' already exists on this node` }); return;
      }
      try {
        const emailValue = (email || '').trim() || `${trimId}@link.local`;
        const bot = await this.manager.addAccount(trimId, emailValue);

        const codeInfo = await new Promise<any>((resolve) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) { resolved = true; bot.authManager.removeListener('msaCode', onCode); resolve(null); }
          }, 30000);
          const onCode = (data: any) => {
            if (!resolved) { resolved = true; clearTimeout(timeout); bot.authManager.removeListener('msaCode', onCode); resolve(data); }
          };
          bot.authManager.on('msaCode', onCode);
          // Connect directly — bypass JoinScheduler so link login isn't blocked by auto-connect queue
          bot.connect().catch(() => {});
        });

        if (codeInfo) {
          logger.info(`API: Link login started for '${trimId}' — code: ${codeInfo.user_code}`);
        }
        res.json({
          success: true,
          accountId: trimId,
          codeInfo: codeInfo ? {
            user_code: codeInfo.user_code,
            verification_uri: codeInfo.verification_uri,
            direct_verification_uri: codeInfo.direct_verification_uri,
          } : null,
        });
      } catch (err: any) {
        logger.error(`API: Failed link login for '${trimId}': ${err.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Remove account ──────────────────────────────────────────────────────
    this.app.post('/api/accounts/remove', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        await this.manager.removeAccount(accountId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Move account to another node ────────────────────────────────────────
    this.app.post('/api/accounts/move', async (req, res) => {
      const { accountId, targetNodeId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      if (!targetNodeId) { res.status(400).json({ success: false, error: 'targetNodeId required' }); return; }
      try {
        const ok = await this.manager.moveAccount(accountId, targetNodeId);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Update account email ────────────────────────────────────────────────
    this.app.post('/api/accounts/update-email', async (req, res) => {
      const { accountId, email } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        await updateAccountFields(accountId, {
          email: (email || '').trim(),
        });
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Group accounts (folders) ─────────────────────────────────────────────
    this.app.post('/api/accounts/group', async (req, res) => {
      const { accountIds, groupName } = req.body;
      if (!Array.isArray(accountIds) || accountIds.length === 0) {
        res.status(400).json({ success: false, error: 'accountIds array required' });
        return;
      }
      try {
        await setAccountGroup(accountIds.map(String), groupName || null);
        res.json({ success: true, groupName: groupName || null, accountIds });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Ungroup accounts ─────────────────────────────────────────────────────
    this.app.post('/api/accounts/ungroup', async (req, res) => {
      const { groupName, accountIds } = req.body;
      try {
        await ungroupAccounts(groupName, accountIds);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Rename account group ─────────────────────────────────────────────────
    this.app.post('/api/accounts/rename-group', async (req, res) => {
      const { oldName, newName } = req.body;
      if (!oldName || !newName) {
        res.status(400).json({ success: false, error: 'oldName and newName required' });
        return;
      }
      try {
        await renameAccountGroup(oldName, newName);
        res.json({ success: true, oldName, newName });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Export System Backup (accounts, nodes, tokens) ───────────────────────
    this.app.get('/api/backup/export', async (req, res) => {
      try {
        let accounts: any[] = [];
        let nodes: any[] = [];
        let tokens: any[] = [];

        try {
          const dbData = await exportAllBackupData();
          accounts = dbData.accounts || [];
          nodes = dbData.nodes || [];
          tokens = dbData.tokens || [];
        } catch (dbErr: any) {
          logger.debug(`exportAllBackupData db fetch: ${dbErr?.message}`);
        }

        // Merge in local node if missing from nodes
        if (!nodes.some((n: any) => n.id === this.config.nodeId)) {
          nodes.push({
            id: this.config.nodeId,
            name: this.config.nodeName,
            url: this.config.nodeUrl,
            owner: this.config.nodeOwner,
            status: 'online',
          });
        }

        // Merge in active local bots if missing from accounts
        for (const bot of this.manager.getAllBots()) {
          if (!accounts.some((a: any) => a.id === bot.accountId)) {
            accounts.push({
              id: bot.accountId,
              node_id: this.config.nodeId,
              email: (bot as any)?.email || '',
              ign: bot.inGameIgn || '',
              gamertag: bot.xboxUsername || '',
              status: (bot as any)?.state || (bot as any)?.status || 'IDLE',
              auto_connect: false,
            });
          }
        }

        // Ensure token records exist for accounts with local tokens on disk
        const accountIds = new Set<string>();
        accounts.forEach(a => accountIds.add(a.id));
        this.manager.getAllBots().forEach(b => accountIds.add(b.accountId));

        const tempBase = path.join(os.tmpdir(), 'donut-bot-profiles');
        if (fs.existsSync(tempBase)) {
          try {
            for (const ent of fs.readdirSync(tempBase)) {
              if (fs.statSync(path.join(tempBase, ent)).isDirectory()) {
                accountIds.add(ent);
              }
            }
          } catch {}
        }
        const legacyBase = path.resolve(process.cwd(), 'profile');
        if (fs.existsSync(legacyBase)) {
          try {
            for (const ent of fs.readdirSync(legacyBase)) {
              if (fs.statSync(path.join(legacyBase, ent)).isDirectory()) {
                accountIds.add(ent);
              }
            }
          } catch {}
        }

        for (const id of accountIds) {
          if (!tokens.some((t: any) => t.account_id === id)) {
            const diskTokens = await TokenStorage.getTokensForAccount(id);
            if (diskTokens && Object.keys(diskTokens).length > 0) {
              tokens.push({
                account_id: id,
                node_id: this.config.nodeId,
                file_name: '__bundle__',
                token_data: JSON.stringify(diskTokens),
                updated_at: new Date().toISOString(),
              });
            }
          }
        }

        const backup = {
          version: 1,
          type: 'donut_bots_backup',
          exportedAt: new Date().toISOString(),
          tables: {
            accounts,
            nodes,
            tokens,
          },
          accounts,
          nodes,
          tokens,
        };

        res.json({
          success: true,
          exportedAt: backup.exportedAt,
          counts: {
            accounts: accounts.length,
            nodes: nodes.length,
            tokens: tokens.length,
          },
          backup,
        });
      } catch (err: any) {
        logger.error(`API: /api/backup/export failed: ${err?.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Import System Backup (completely replaces/overwrites database records) ──
    this.app.post('/api/backup/import', async (req, res) => {
      try {
        const body = req.body;
        if (!body) {
          return res.status(400).json({ success: false, error: 'Empty backup payload' });
        }

        const data = body.backup || body.tables || body;
        const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
        const nodes: any[] = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data.backend_nodes) ? data.backend_nodes : []);
        const tokens: any[] = Array.isArray(data.tokens) ? data.tokens : (Array.isArray(data.auth_tokens) ? data.auth_tokens : []);

        if (accounts.length === 0 && nodes.length === 0 && tokens.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Invalid backup file. No accounts, nodes, or tokens found in payload.',
          });
        }

        // 0. Cleanly disconnect all existing bots and purge token files
        logger.info('Preparing system backup import: disconnecting all active accounts...');
        await this.manager.disconnectAll();
        for (const bot of this.manager.getAllBots()) {
          try { await bot.dispose(); } catch {}
        }
        try {
          const allNodesList = await getAllNodes();
          for (const n of allNodesList) {
            if (n.id !== this.config.nodeId) {
              await insertCommand(n.id, null, 'DISCONNECT_ALL', {});
            }
          }
        } catch {}
        await TokenStorage.clearAllTokens();

        // 1. Overwrite database records in Supabase
        let dbResult: any = { accountsCount: 0, nodesCount: 0, tokensCount: 0 };
        try {
          dbResult = await importAllBackupData({
            accounts,
            nodes,
            tokens,
            settings: data.settings,
            permissions: data.permissions,
            ignoreList: data.ignoreList,
            commands: data.commands,
            accountGroups: data.accountGroups,
          });
        } catch (dbErr: any) {
          logger.warn(`Supabase importAllBackupData notice: ${dbErr?.message}`);
        }

        // 2. Write tokens to disk so bots have immediate authentication without /link
        let tokensWritten = 0;
        for (const tok of tokens) {
          const accId = String(tok.account_id || tok.accountId || tok.id || '').trim();
          if (!accId) continue;
          let parsedData = tok.token_data || tok.tokens || tok;
          if (typeof parsedData === 'string') {
            try {
              parsedData = JSON.parse(parsedData);
            } catch {}
          }
          if (parsedData && typeof parsedData === 'object') {
            const resWrite = await TokenStorage.importTokensForAccount(accId, tok.node_id || this.config.nodeId, parsedData);
            if (resWrite.success) tokensWritten++;
          }
        }

        // 3. Instantiate / overwrite bots in AccountManager for this node
        let botsInstantiated = 0;
        for (const acc of accounts) {
          const accId = String(acc.id || acc.accountId || '').trim();
          if (!accId) continue;
          const targetNode = acc.node_id || this.config.nodeId;
          if (targetNode === this.config.nodeId || !this.manager.getBot(accId)) {
            try {
              await this.manager.instantiateBot({
                id: accId,
                email: acc.email || '',
                nodeId: targetNode,
                autoConnect: acc.auto_connect || false,
                offline: acc.offline_mode || false,
                profilesFolder: '',
              });
              botsInstantiated++;
            } catch (botErr: any) {
              logger.debug(`instantiateBot on import [${accId}]: ${botErr?.message}`);
            }
          }
        }

        res.json({
          success: true,
          message: 'System backup imported and database records overwritten successfully',
          counts: {
            accounts: accounts.length,
            nodes: nodes.length,
            tokens: tokens.length,
            tokensWrittenOnDisk: tokensWritten,
            botsInstantiated: botsInstantiated,
          },
        });
      } catch (err: any) {
        logger.error(`API: /api/backup/import failed: ${err?.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Sync to Secondary Supabase (Backup All) ──────────────────────────────
    this.app.post('/api/backup/sync-secondary', async (req, res) => {
      try {
        const result = await syncToSecondarySupabase();
        if (result.success) {
          res.json({
            success: true,
            message: 'All data backed up to secondary Supabase successfully (excluding logs and junk files)',
            counts: result.counts,
          });
        } else {
          res.status(500).json({
            success: false,
            error: result.error || 'Failed to sync to secondary Supabase',
            counts: result.counts,
          });
        }
      } catch (err: any) {
        logger.error(`API: /api/backup/sync-secondary failed: ${err?.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Load Backup from Secondary Supabase ───────────────────────────────────
    this.app.post('/api/backup/load-secondary', async (req, res) => {
      try {
        logger.info('Preparing clean database restore: disconnecting all active accounts...');
        // Cleanly disconnect all local bots
        await this.manager.disconnectAll();
        for (const bot of this.manager.getAllBots()) {
          try { await bot.dispose(); } catch {}
        }
        // Broadcast DISCONNECT_ALL to worker nodes
        try {
          const nodes = await getAllNodes();
          for (const n of nodes) {
            if (n.id !== this.config.nodeId) {
              await insertCommand(n.id, null, 'DISCONNECT_ALL', {});
            }
          }
        } catch {}

        // Clear local token files from disk
        await TokenStorage.clearAllTokens();

        const result = await loadFromSecondarySupabase();
        if (!result.success) {
          return res.status(500).json({
            success: false,
            error: result.error || 'Failed to load backup from secondary Supabase',
            counts: result.counts,
          });
        }

        const accounts = result.data?.accounts || [];
        const tokens = result.data?.tokens || [];

        // 1. Write restored tokens to disk
        let tokensWritten = 0;
        for (const tok of tokens) {
          const accId = String(tok.account_id || tok.accountId || tok.id || '').trim();
          if (!accId) continue;
          let parsedData = tok.token_data || tok.tokens || tok;
          if (typeof parsedData === 'string') {
            try {
              parsedData = JSON.parse(parsedData);
            } catch {}
          }
          if (parsedData && typeof parsedData === 'object') {
            const resWrite = await TokenStorage.importTokensForAccount(accId, tok.node_id || this.config.nodeId, parsedData);
            if (resWrite.success) tokensWritten++;
          }
        }

        // 2. Instantiate restored accounts matching this node
        let botsInstantiated = 0;
        for (const acc of accounts) {
          const accId = String(acc.id || acc.accountId || '').trim();
          if (!accId) continue;
          const targetNode = acc.node_id || this.config.nodeId;
          if (targetNode === this.config.nodeId) {
            try {
              await this.manager.instantiateBot({
                id: accId,
                email: acc.email || '',
                nodeId: targetNode,
                autoConnect: acc.auto_connect || false,
                offline: acc.offline_mode || false,
                profilesFolder: '',
              });
              botsInstantiated++;
            } catch (botErr: any) {
              logger.debug(`instantiateBot on load-secondary [${accId}]: ${botErr?.message}`);
            }
          } else {
            // Signal target worker node to load its restored bot
            try {
              await insertCommand(targetNode, accId, 'LOAD_AND_CONNECT', { accountId: accId });
            } catch {}
          }
        }

        // 3. Trigger ignore list refresh
        try {
          await IgnoreListStorage.getIgnoredPlayers();
        } catch {}

        res.json({
          success: true,
          message: 'Backup loaded from Secondary Supabase and restored to Primary Supabase successfully',
          counts: {
            ...result.counts,
            tokensWrittenOnDisk: tokensWritten,
            botsInstantiated,
          },
        });
      } catch (err: any) {
        logger.error(`API: /api/backup/load-secondary failed: ${err?.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Admin: Clear Database (NODE / ACCOUNTS) ──────────────────────────────
    this.app.post('/api/admin/clear-database', async (req, res) => {
      const { clearNodes, clearAccounts, password, adminSecret } = req.body;
      const configuredSecret = process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || process.env.API_SECRET || this.config.webServer.apiSecret;
      const providedSecret = req.headers['x-api-secret'] || password || adminSecret;

      if (configuredSecret && providedSecret !== configuredSecret) {
        logger.warn('Unauthorized attempt to clear database with invalid admin password');
        res.status(401).json({ success: false, error: 'Invalid admin authentication password' });
        return;
      }

      if (!clearNodes && !clearAccounts) {
        res.status(400).json({ success: false, error: 'Please select at least one item (NODE or ACCOUNTS) to clear.' });
        return;
      }

      try {
        if (clearAccounts) {
          logger.info('Admin action: cleanly disconnecting all bots and clearing all accounts...');
          // 1. Disconnect all local bots
          await this.manager.disconnectAll();
          for (const bot of this.manager.getAllBots()) {
            try { await bot.dispose(); } catch {}
          }
          // 2. Command remote nodes to disconnect all bots
          try {
            const nodes = await getAllNodes();
            for (const n of nodes) {
              if (n.id !== this.config.nodeId) {
                await insertCommand(n.id, null, 'DISCONNECT_ALL', {});
              }
            }
          } catch {}

          // 3. Clear all cached tokens from disk
          await TokenStorage.clearAllTokens();

          // 4. Wipe tables from database
          const wipeRes = await clearDatabaseTables({ clearAccounts: true });
          if (!wipeRes.success) throw new Error(wipeRes.error || 'Failed to clear accounts from database');
        }

        if (clearNodes) {
          logger.info('Admin action: clearing worker nodes from database...');
          const wipeRes = await clearDatabaseTables({ clearNodes: true, preserveNodeId: this.config.nodeId });
          if (!wipeRes.success) throw new Error(wipeRes.error || 'Failed to clear nodes from database');
        }

        res.json({
          success: true,
          message: 'Database cleared successfully',
          cleared: {
            nodes: Boolean(clearNodes),
            accounts: Boolean(clearAccounts),
          },
        });
      } catch (err: any) {
        logger.error(`API: /api/admin/clear-database failed: ${err?.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Get Secondary Supabase Sync Status ──────────────────────────────────
    this.app.get('/api/backup/secondary-status', (_req, res) => {
      res.json({
        configured: !!(process.env.SECONDARY_SUPABASE_URL && process.env.SECONDARY_SUPABASE_SERVICE_ROLE_KEY),
        lastSync: getLastSecondarySyncStatus(),
      });
    });

    // ── Connect ─────────────────────────────────────────────────────────────
    this.app.post('/api/accounts/connect', async (req, res) => {
      const { accountId, forceReload } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        if (!this.manager.getBot(accountId) || forceReload) {
          await this.manager.loadAccountFromSupabase(accountId);
        }
        const ok = this.manager.scheduleAccountConnect(accountId);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Disconnect ──────────────────────────────────────────────────────────
    this.app.post('/api/accounts/disconnect', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        await this.manager.disconnectAccount(accountId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Connect All ──────────────────────────────────────────────────────────
    this.app.post('/api/accounts/connect-all', (req, res) => {
      try {
        const scheduled = this.manager.connectAll();
        res.json({ success: true, scheduled });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Disconnect All ───────────────────────────────────────────────────────
    this.app.post('/api/accounts/disconnect-all', async (req, res) => {
      try {
        const count = await this.manager.disconnectAll();
        res.json({ success: true, count });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Internal Discord Log Relay (Worker -> Master) ────────────────────────
    this.app.post('/api/internal/discord-log', async (req, res) => {
      const { type, botName, ign, serverHost, reason, message, playerName, distance, posStr } = req.body;
      try {
        if (type === 'join') {
          await discordLogger.logBotJoin(botName, ign, serverHost);
        } else if (type === 'leave') {
          await discordLogger.logBotLeft(botName, ign, reason);
        } else if (type === 'afk') {
          await discordLogger.logAfkActivity(botName, message);
        } else if (type === 'player_detected') {
          await discordLogger.logPlayerDetected(botName, playerName, distance, posStr);
        }
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Clear auth & retry ──────────────────────────────────────────────────
    this.app.post('/api/accounts/clear-auth', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        const ok = await this.manager.clearAccountAuthAndRetry(accountId);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Sign out ────────────────────────────────────────────────────────────
    this.app.post('/api/accounts/signout', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        const ok = await this.manager.signOutAccount(accountId);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Retry profile check ─────────────────────────────────────────────────
    this.app.post('/api/accounts/retry-profile', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        const bot = this.manager.getBot(accountId);
        if (!bot) { res.status(404).json({ success: false, error: `Account '${accountId}' not found` }); return; }
        const ok = await bot.authManager.retryProfileCheck();
        res.json({ success: ok, status: bot.authManager.getStatus(), identity: bot.authManager.getIdentity() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Bot actions ─────────────────────────────────────────────────────────
    this.app.post('/api/bot/action', async (req, res) => {
      const { accountId, action, state, minDelay, maxDelay, degrees, distance } = req.body;
      if (!accountId || !action) {
        res.status(400).json({ success: false, error: 'accountId and action required' }); return;
      }
      try {
        const result = this.manager.executeBotAction(accountId, action, state, { minDelay, maxDelay, degrees, distance });

        // If target is 'all', broadcast to all other nodes via Supabase commands
        if (accountId === 'all') {
          try {
            const nodes = await getAllNodes();
            const otherNodes = nodes.filter((n: any) => n.id !== this.config.nodeId);
            for (const node of otherNodes) {
              await insertCommand(node.id, null, 'BOT_ACTION', {
                action,
                accountId: 'all',
                state,
                options: { minDelay, maxDelay, degrees, distance },
              }).catch(() => {});
            }
          } catch {}
        } else if (!result.success && result.error?.includes('No active bot')) {
          // If not found locally, check if the account is hosted on another node
          try {
            const accountRow = await getAccountById(accountId);
            if (accountRow && accountRow.node_id && accountRow.node_id !== this.config.nodeId) {
              await insertCommand(accountRow.node_id, accountId, 'BOT_ACTION', {
                action,
                accountId,
                state,
                options: { minDelay, maxDelay, degrees, distance },
              });
              // Also attempt direct HTTP if node URL is reachable
              const nodes = await getAllNodes();
              const targetNode = nodes.find((n: any) => n.id === accountRow.node_id);
              if (targetNode && targetNode.url) {
                const axios = require('axios');
                axios.post(`${targetNode.url}/api/bot/action`, req.body, { timeout: 3000 }).catch(() => {});
              }
              res.json({ success: true, relayed: true, targetNodeId: accountRow.node_id });
              return;
            }
          } catch {}
        }

        res.json(result);
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Bot chat ────────────────────────────────────────────────────────────
    this.app.post('/api/bot/chat', (req, res) => {
      const { accountId, message } = req.body;
      if (!accountId || !message) {
        res.status(400).json({ success: false, error: 'accountId and message required' }); return;
      }
      try {
        const result = this.manager.sendBotChat(accountId, message);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── AFK controls ────────────────────────────────────────────────────────
    this.app.post('/api/afk/set', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        res.json(this.manager.setAfkSpot(accountId));
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    this.app.post('/api/afk/reset', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        res.json(this.manager.resetAfkSpot(accountId));
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    this.app.post('/api/afk/toggle-monitor', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        res.json(this.manager.toggleAfkMonitor(accountId));
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Settings ────────────────────────────────────────────────────────────
    this.app.get('/api/settings', async (_req, res) => {
      try {
        const settings = await getNodeSettings(this.config.nodeId);
        res.json({ settings: settings || {} });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    this.app.post('/api/settings', async (req, res) => {
      try {
        await upsertNodeSettings(this.config.nodeId, req.body);
        applyNodeSettings(req.body);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Permissions ─────────────────────────────────────────────────────────
    this.app.get('/api/permissions', async (_req, res) => {
      try {
        res.json({ allowedUsers: await PermissionStorage.getAllAllowedUsers() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    this.app.post('/api/permissions/add', async (req, res) => {
      const { userId, tag } = req.body;
      if (!userId) { res.status(400).json({ success: false, error: 'userId required' }); return; }
      try {
        const ok = await PermissionStorage.addAllowedUser(userId.trim(), tag || '');
        res.json({ success: ok, allowedUsers: await PermissionStorage.getAllAllowedUsers() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    this.app.post('/api/permissions/remove', async (req, res) => {
      const { userId } = req.body;
      if (!userId) { res.status(400).json({ success: false, error: 'userId required' }); return; }
      try {
        const ok = await PermissionStorage.removeAllowedUser(userId.trim());
        res.json({ success: ok, allowedUsers: await PermissionStorage.getAllAllowedUsers() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Ignore list ─────────────────────────────────────────────────────────
    this.app.get('/api/ignore', async (_req, res) => {
      try {
        res.json({ ignoredPlayers: await IgnoreListStorage.getIgnoredPlayers() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    this.app.post('/api/ignore/add', async (req, res) => {
      const { player } = req.body;
      if (!player) { res.status(400).json({ success: false, error: 'player required' }); return; }
      try {
        const ok = await IgnoreListStorage.addPlayer(player.trim());
        res.json({ success: ok, ignoredPlayers: await IgnoreListStorage.getIgnoredPlayers() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    this.app.post('/api/ignore/remove', async (req, res) => {
      const { player } = req.body;
      if (!player) { res.status(400).json({ success: false, error: 'player required' }); return; }
      try {
        const ok = await IgnoreListStorage.removePlayer(player.trim());
        res.json({ success: ok, ignoredPlayers: await IgnoreListStorage.getIgnoredPlayers() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Command bus ─────────────────────────────────────────────────────────
    this.app.post('/api/command', async (req, res) => {
      const { accountId, action, payload, targetNodeId } = req.body;
      if (!action) { res.status(400).json({ success: false, error: 'action required' }); return; }
      try {
        const nodeId = targetNodeId || this.config.nodeId;
        await insertCommand(nodeId, accountId || null, action, payload || {});
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });



    // ── Logs history ────────────────────────────────────────────────────────
    this.app.get('/api/logs', (_req, res) => {
      const limit = Math.min(parseInt(_req.query.limit as string) || 200, 500);
      const buffer = logger.getBuffer();
      res.json({ logs: buffer.slice(-limit) });
    });

    // ── Logs SSE stream ─────────────────────────────────────────────────────
    this.app.get('/api/logs/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const onLog = (entry: any) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      };
      logger.on('log', onLog);

      req.on('close', () => {
        logger.removeListener('log', onLog);
      });
    });
  }

  public start(): void {
    this.app.listen(this.port, '0.0.0.0', () => {
      logger.info(`API server started on port ${this.port} | Node: ${this.config.nodeId}`);
      logger.info(`CORS allowed origin: ${this.config.webServer.frontendUrl}`);
    });
  }
}
