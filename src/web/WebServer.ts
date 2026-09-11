import express from 'express';
import { AppConfig } from '../config';
import { AccountManager } from '../network/AccountManager';
import { PermissionStorage } from '../storage/PermissionStorage';
import { IgnoreListStorage } from '../storage/IgnoreListStorage';
import {
  upsertNodeSettings,
  getNodeSettings,
  insertCommand,
  getAllNodes,
} from '../database/SupabaseClient';
import { logger } from '../utils/logger';

export class WebServer {
  private app: express.Application;
  private manager: AccountManager;
  private config: AppConfig;
  private port: number;

  constructor(manager: AccountManager, config: AppConfig) {
    this.app = express();
    this.manager = manager;
    this.config = config;
    this.port = config.webServer.port;
    this.configureMidleware();
    this.configureRoutes();
  }

  private configureMidleware(): void {
    this.app.use(express.json());

    // CORS — allow Vercel frontend and any configured origin
    this.app.use((req, res, next) => {
      const origin = req.headers.origin || '';
      const allowedOrigin = this.config.webServer.frontendUrl === '*'
        ? '*'
        : this.config.webServer.frontendUrl;
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Api-Secret');
      if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
      next();
    });

    // Optional API secret validation
    this.app.use('/api/', (req, res, next) => {
      const secret = this.config.webServer.apiSecret;
      if (!secret) { next(); return; } // no secret = open API
      const provided = req.headers['x-api-secret'] || req.query['apiSecret'];
      if (provided === secret) { next(); return; }
      res.status(401).json({ success: false, error: 'Unauthorized' });
    });
  }

  private configureRoutes(): void {
    // ── Health check ────────────────────────────────────────────────────────
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        nodeId: this.config.nodeId,
        nodeName: this.config.nodeName,
        uptime: process.uptime(),
        botCount: this.manager.getAllBots().length,
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        nodeId: this.config.nodeId,
        nodeName: this.config.nodeName,
        uptime: process.uptime(),
        botCount: this.manager.getAllBots().length,
        timestamp: new Date().toISOString(),
      });
    });

    // ── Status (this node's bots only) ──────────────────────────────────────
    this.app.get('/api/status', (req, res) => {
      res.json({
        nodeId: this.config.nodeId,
        nodeName: this.config.nodeName,
        server: this.config.server,
        accounts: this.manager.getStatusSummary(),
      });
    });

    // ── All nodes (read from Supabase) ──────────────────────────────────────
    this.app.get('/api/nodes', async (req, res) => {
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
        res.status(400).json({ success: false, error: 'Account ID is required' });
        return;
      }
      if (!email || typeof email !== 'string') {
        res.status(400).json({ success: false, error: 'Email is required' });
        return;
      }
      if (this.manager.getBot(id)) {
        res.status(400).json({ success: false, error: `Account '${id}' already exists on this node` });
        return;
      }
      try {
        await this.manager.addAccount(id, email);
        this.manager.scheduleAccountConnect(id);
        logger.info(`API: Added account '${id}'`);
        res.json({ success: true, accountId: id });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Remove account ──────────────────────────────────────────────────────
    this.app.post('/api/accounts/remove', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      await this.manager.removeAccount(accountId);
      res.json({ success: true });
    });

    // ── Connect ─────────────────────────────────────────────────────────────
    this.app.post('/api/accounts/connect', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      const ok = this.manager.scheduleAccountConnect(accountId);
      res.json({ success: ok });
    });

    // ── Disconnect ──────────────────────────────────────────────────────────
    this.app.post('/api/accounts/disconnect', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      await this.manager.disconnectAccount(accountId);
      res.json({ success: true });
    });

    // ── Clear auth & retry ──────────────────────────────────────────────────
    this.app.post('/api/accounts/clear-auth', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      const ok = await this.manager.clearAccountAuthAndRetry(accountId);
      res.json({ success: ok });
    });

    // ── Sign out ────────────────────────────────────────────────────────────
    this.app.post('/api/accounts/signout', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      const ok = await this.manager.signOutAccount(accountId);
      res.json({ success: ok });
    });

    // ── Retry profile check ─────────────────────────────────────────────────
    this.app.post('/api/accounts/retry-profile', async (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      const bot = this.manager.getBot(accountId);
      if (!bot) { res.status(404).json({ success: false, error: `Account '${accountId}' not found` }); return; }
      try {
        const ok = await bot.authManager.retryProfileCheck();
        res.json({ success: ok, status: bot.authManager.getStatus(), identity: bot.authManager.getIdentity() });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Bot actions ─────────────────────────────────────────────────────────
    this.app.post('/api/bot/action', (req, res) => {
      const { accountId, action, state, minDelay, maxDelay, degrees, distance } = req.body;
      if (!accountId || !action) {
        res.status(400).json({ success: false, error: 'accountId and action required' });
        return;
      }
      const result = this.manager.executeBotAction(accountId, action, state, { minDelay, maxDelay, degrees, distance });
      res.json(result);
    });

    // ── Bot chat ────────────────────────────────────────────────────────────
    this.app.post('/api/bot/chat', (req, res) => {
      const { accountId, message } = req.body;
      if (!accountId || !message) {
        res.status(400).json({ success: false, error: 'accountId and message required' });
        return;
      }
      const result = this.manager.sendBotChat(accountId, message);
      res.json(result);
    });

    // ── AFK controls ────────────────────────────────────────────────────────
    this.app.post('/api/afk/set', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      res.json(this.manager.setAfkSpot(accountId));
    });

    this.app.post('/api/afk/reset', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      res.json(this.manager.resetAfkSpot(accountId));
    });

    this.app.post('/api/afk/toggle-monitor', (req, res) => {
      const { accountId } = req.body;
      if (!accountId) { res.status(400).json({ success: false, error: 'accountId required' }); return; }
      res.json(this.manager.toggleAfkMonitor(accountId));
    });

    // ── Settings (synced to Supabase node_settings) ─────────────────────────
    this.app.get('/api/settings', async (req, res) => {
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
        // Apply to in-memory config immediately
        const { applyNodeSettings } = require('../config');
        applyNodeSettings(req.body);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });

    // ── Permissions ─────────────────────────────────────────────────────────
    this.app.get('/api/permissions', async (req, res) => {
      res.json({ allowedUsers: await PermissionStorage.getAllAllowedUsers() });
    });

    this.app.post('/api/permissions/add', async (req, res) => {
      const { userId, tag } = req.body;
      if (!userId) { res.status(400).json({ success: false, error: 'userId required' }); return; }
      const ok = await PermissionStorage.addAllowedUser(userId.trim(), tag || '');
      res.json({ success: ok, allowedUsers: await PermissionStorage.getAllAllowedUsers() });
    });

    this.app.post('/api/permissions/remove', async (req, res) => {
      const { userId } = req.body;
      if (!userId) { res.status(400).json({ success: false, error: 'userId required' }); return; }
      const ok = await PermissionStorage.removeAllowedUser(userId.trim());
      res.json({ success: ok, allowedUsers: await PermissionStorage.getAllAllowedUsers() });
    });

    // ── Ignore list ─────────────────────────────────────────────────────────
    this.app.get('/api/ignore', async (req, res) => {
      res.json({ ignoredPlayers: await IgnoreListStorage.getIgnoredPlayers() });
    });

    this.app.post('/api/ignore/add', async (req, res) => {
      const { player } = req.body;
      if (!player) { res.status(400).json({ success: false, error: 'player required' }); return; }
      const ok = await IgnoreListStorage.addPlayer(player.trim());
      res.json({ success: ok, ignoredPlayers: await IgnoreListStorage.getIgnoredPlayers() });
    });

    this.app.post('/api/ignore/remove', async (req, res) => {
      const { player } = req.body;
      if (!player) { res.status(400).json({ success: false, error: 'player required' }); return; }
      const ok = await IgnoreListStorage.removePlayer(player.trim());
      res.json({ success: ok, ignoredPlayers: await IgnoreListStorage.getIgnoredPlayers() });
    });

    // ── Command bus (Vercel can also insert commands via Supabase directly) ──
    this.app.post('/api/command', async (req, res) => {
      const { accountId, action, payload, targetNodeId } = req.body;
      if (!action) { res.status(400).json({ success: false, error: 'action required' }); return; }
      const nodeId = targetNodeId || this.config.nodeId;
      try {
        await insertCommand(nodeId, accountId || null, action, payload || {});
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message });
      }
    });
  }

  public start(): void {
    this.app.listen(this.port, '0.0.0.0', () => {
      logger.info(`API server started on port ${this.port} | Node: ${this.config.nodeId}`);
      logger.info(`CORS allowed origin: ${this.config.webServer.frontendUrl}`);
    });
  }
}
