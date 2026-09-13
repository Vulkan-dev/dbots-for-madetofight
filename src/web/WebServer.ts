import express from 'express';
import { AppConfig, applyNodeSettings } from '../config';
import { AccountManager } from '../network/AccountManager';
import { PermissionStorage } from '../storage/PermissionStorage';
import { IgnoreListStorage } from '../storage/IgnoreListStorage';
import {
  upsertNodeSettings,
  getNodeSettings,
  insertCommand,
  getAllNodes,
  updateAccountFields,
  getAccountById,
} from '../database/SupabaseClient';
import { logger } from '../utils/logger';
import { discordLogger } from '../discord/DiscordLogger';
import { TokenStorage } from '../auth/TokenStorage';

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
        const bot = this.manager.getBot(accountId);
        if (bot) {
          const ok = await this.manager.moveAccount(accountId, targetNodeId);
          res.json({ success: ok });
        } else {
          // If bot is hosted on another node, update Supabase transfer and signal target node
          const { TokenStorage } = require('../auth/TokenStorage');
          await TokenStorage.transferTokens(accountId, targetNodeId);
          await updateAccountFields(accountId, {
            node_id: targetNodeId,
            auto_connect: true,
            status: 'CONNECTING',
          });
          await insertCommand(targetNodeId, accountId, 'LOAD_AND_CONNECT', { accountId });
          res.json({ success: true });
        }
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

    // ── Connect ─────────────────────────────────────────────────────────────
    this.app.post('/api/accounts/connect', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
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

    // ── Export Tokens ────────────────────────────────────────────────────────
    this.app.get('/api/tokens/export', async (req, res) => {
      try {
        const accountId = req.query.accountId ? String(req.query.accountId).trim() : undefined;
        const result = await TokenStorage.exportTokens(accountId);
        if (req.query.download === 'true') {
          const filename = accountId && accountId !== 'all'
            ? `bot-${accountId}-tokens.json`
            : `donut-bots-tokens-${new Date().toISOString().slice(0, 10)}.json`;
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Type', 'application/json');
        }
        res.json(result);
      } catch (err: any) {
        logger.error(`API: Export tokens failed: ${err.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Import / Upload Accounts via Token ──────────────────────────────────
    this.app.post('/api/tokens/import', async (req, res) => {
      try {
        const body = req.body;
        let accountsToImport: any[] = [];

        if (body && Array.isArray(body.accounts)) {
          accountsToImport = body.accounts;
        } else if (Array.isArray(body)) {
          accountsToImport = body;
        } else if (body && body.accountId && (body.tokens || body.tokenData || body.token_data)) {
          accountsToImport = [body];
        } else if (typeof body === 'object' && body !== null) {
          if (body.type === 'donut-bots-tokens' && Array.isArray(body.accounts)) {
            accountsToImport = body.accounts;
          } else {
            for (const [key, val] of Object.entries(body)) {
              if (typeof val === 'object' && val !== null) {
                accountsToImport.push({
                  accountId: key,
                  tokens: val,
                  nodeId: (val as any).nodeId,
                  email: (val as any).email,
                });
              }
            }
          }
        }

        if (accountsToImport.length === 0) {
          res.status(400).json({ success: false, error: 'No valid account token entries found in request body' });
          return;
        }

        const defaultNode = (req.body.targetNodeId || this.config.nodeId);
        const imported: string[] = [];
        const errors: Array<{ accountId: string; error: string }> = [];

        for (const item of accountsToImport) {
          const accId = String(item.accountId || item.id || item.account_id || '').trim();
          if (!accId) continue;
          const email = (item.email || '').trim();
          const targetNode = item.nodeId || item.node_id || defaultNode;
          const tokens = item.tokens || item.tokenData || item.token_data || item;

          const impRes = await TokenStorage.importAccountTokens(
            accId,
            email,
            tokens,
            targetNode,
            this.config.nodeId
          );

          if (impRes.success) {
            imported.push(accId);
            if (targetNode === this.config.nodeId) {
              await this.manager.reloadAccount(accId).catch(() => {});
            } else {
              try {
                const nodes = await getAllNodes();
                const nodeObj = nodes.find((n: any) => n.id === targetNode);
                if (nodeObj && nodeObj.url) {
                  const axios = require('axios');
                  axios.post(`${nodeObj.url}/api/accounts/reload`, { accountId: accId }, { timeout: 4000 }).catch(() => {});
                }
              } catch {}
              await insertCommand(targetNode, accId, 'RELOAD_ACCOUNT', { accountId: accId }).catch(() => {});
            }
          } else {
            errors.push({ accountId: accId, error: impRes.error || 'Validation failed' });
          }
        }

        res.json({
          success: imported.length > 0,
          importedCount: imported.length,
          accounts: imported,
          errors,
        });
      } catch (err: any) {
        logger.error(`API: Import tokens failed: ${err.message}`);
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Reload Account ──────────────────────────────────────────────────────
    this.app.post('/api/accounts/reload', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      try {
        const bot = await this.manager.reloadAccount(String(accountId));
        res.json({ success: true, loaded: Boolean(bot) });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Bot actions ─────────────────────────────────────────────────────────
    this.app.post('/api/bot/action', (req, res) => {
      const { accountId, action, state, minDelay, maxDelay, degrees, distance } = req.body;
      if (!accountId || !action) {
        res.status(400).json({ success: false, error: 'accountId and action required' }); return;
      }
      try {
        const result = this.manager.executeBotAction(accountId, action, state, { minDelay, maxDelay, degrees, distance });
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

    // ── Internal Discord Category Registration ──────────────────────────────
    this.app.post('/api/internal/register-node-category', async (req, res) => {
      try {
        const { nodeId, categoryId } = req.body;
        if (nodeId && categoryId && this.discordBot) {
          await this.discordBot.registerNodeCategory(nodeId, categoryId);
          return res.json({ success: true });
        }
        res.status(400).json({ success: false, error: 'Missing nodeId/categoryId or Discord bot not running' });
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
