import dotenv from 'dotenv';
dotenv.config();
import './auth/patchPrismarineAuth';

import { loadConfig, applyNodeSettings } from './config';
import { AccountManager } from './network/AccountManager';
import { WebServer } from './web/WebServer';
import { DiscordBot } from './discord/DiscordBot';
import { logger } from './utils/logger';
import {
  initSupabaseSchema,
  registerNode,
  heartbeatNode,
  markNodeOffline,
  getNodeSettings,
  insertCommand,
  getAllNodes,
  syncToSecondarySupabase,
} from './database/SupabaseClient';

import { sanitizeErrorMessage } from './utils/ErrorSanitizer';

// Intercept raw console.error calls from third-party libraries (e.g. bedrock-protocol client/auth.js)
// to prevent massive raw HTML dumps from Azure WAF 403 pages
const origConsoleError = console.error;
console.error = function (...args: any[]) {
  const sanitizedArgs = args.map((arg) => {
    if (typeof arg === 'string' && (arg.includes('<!DOCTYPE') || arg.includes('The request is blocked'))) {
      return sanitizeErrorMessage(arg);
    }
    if (arg instanceof Error && (arg.message.includes('<!DOCTYPE') || arg.message.includes('The request is blocked'))) {
      return sanitizeErrorMessage(arg.message);
    }
    return arg;
  });
  origConsoleError.apply(console, sanitizedArgs);
};

// ── Global error guards ──────────────────────────────────────────────────────
process.on('uncaughtException', (err: any) => {
  const msg = err?.message || err?.toString() || '';
  if (msg.includes('Invalid tag') || msg.includes('Read error') || msg.includes('Deserialization')) {
    logger.debug(`Suppressed non-fatal library exception: ${msg}`);
    return;
  }
  logger.error(`Uncaught exception: ${sanitizeErrorMessage(err)}`);
});

process.on('unhandledRejection', (reason: any) => {
  const cleanMsg = sanitizeErrorMessage(reason);
  if (
    cleanMsg.includes('Azure WAF') ||
    cleanMsg.includes('The request is blocked') ||
    cleanMsg.includes('Multiple network operations failed')
  ) {
    logger.debug(`Handled async rejection from network rate limit: ${cleanMsg}`);
    return;
  }
  logger.error(`Unhandled promise rejection: ${cleanMsg}`);
});

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();

  console.log(`
====================================================================
  DONUT SMP BEDROCK BOT — Railway Edition
  Node ID    : ${config.nodeId}
  Node Name  : ${config.nodeName}
  Owner      : ${config.nodeOwner || 'N/A'}
  Server     : ${config.server.host}:${config.server.port}
  Discord    : ${config.discord.isMaster ? 'MASTER (controls all nodes)' : 'disabled'}
  Node URL   : ${config.nodeUrl}
====================================================================
`);

  // ── Supabase schema check ──────────────────────────────────────────────────
  logger.info('Checking Supabase connection and schema...');
  await initSupabaseSchema();

  // ── Register this node in Supabase ──────────────────────────────────────────
  try {
    await registerNode(config.nodeId, config.nodeName, config.nodeUrl, config.nodeOwner);
    logger.info(`Node '${config.nodeId}' registered in Supabase at ${config.nodeUrl}`);
  } catch (err: any) {
    logger.error(`CRITICAL: Failed to register node '${config.nodeId}': ${err.message}`);
    logger.error('Node will not appear in the frontend. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    logger.error('Make sure the backend_nodes table exists in Supabase (run the schema SQL).');
  }

  // ── Load node settings from Supabase ────────────────────────────────────────
  try {
    const savedSettings = await getNodeSettings(config.nodeId);
    if (savedSettings) {
      applyNodeSettings(savedSettings);
      logger.info('Applied node settings from Supabase');
    }
  } catch (err: any) {
    logger.debug(`Failed to load node settings: ${err.message}`);
  }

  // ── Account Manager + load accounts from Supabase ──────────────────────────
  const manager = new AccountManager(config);
  await manager.loadAccountsFromSupabase();
  logger.info(`Loaded ${manager.getAllBots().length} bot(s) from Supabase`);

  // ── Auto-connect bots ───────────────────────────────────────────────────────
  manager.connectAutoConnectAccounts();

  // ── Start Supabase status sync & command polling ────────────────────────────
  manager.startStatusSync(15000);
  manager.startCommandPolling(5000);

  // ── Web API server ──────────────────────────────────────────────────────────
  const webServer = new WebServer(manager, config);
  webServer.start();

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  const heartbeatTimer = setInterval(async () => {
    try {
      await heartbeatNode(config.nodeId, manager.getAllBots().length);
    } catch (err: any) {
      logger.debug(`Heartbeat failed: ${err.message}`);
    }
  }, 30000);

  // ── Dual Supabase Automated 24-Hour Backup ─────────────────────────────────
  if (config.secondarySupabase) {
    logger.info('Dual Supabase system active — secondary backup configured');
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

    // Initial sync after 60 seconds of startup to ensure all initial boots/tokens are settled
    setTimeout(async () => {
      try {
        await syncToSecondarySupabase();
      } catch (err: any) {
        logger.warn(`Initial secondary backup failed: ${err?.message}`);
      }
    }, 60000);

    // Recurring 24-hour backup
    setInterval(async () => {
      try {
        logger.info('Executing scheduled 24-hour Dual Supabase backup...');
        await syncToSecondarySupabase();
      } catch (err: any) {
        logger.error(`Scheduled 24-hour secondary backup error: ${err?.message}`);
      }
    }, TWENTY_FOUR_HOURS_MS);
  }

  // ── Discord Bot (only on master node) ──────────────────────────────────────
  let discordBot: DiscordBot | null = null;
  if (config.discord.isMaster && config.discord.token) {
    discordBot = new DiscordBot(manager, config);
    await discordBot.start();
    webServer.setDiscordBot(discordBot);
    logger.info('Discord master bot started — controlling all nodes via Supabase');
  } else if (config.discord.isMaster && !config.discord.token) {
    logger.warn('DISCORD_MASTER=true but DISCORD_TOKEN is not set. Discord bot disabled.');
  }

  // ── Announce Node Category to Master Node ──────────────────────────────────
  const nodeCatId = (config.discord.nodeBotCategoryId || process.env.NODE_DISCORD_BOT_CATEGORY_ID || '').trim();
  if (nodeCatId) {
    if (discordBot) {
      await discordBot.registerNodeCategory(config.nodeId, nodeCatId);
    } else {
      const announceCategory = async () => {
        try {
          // 1. Send command to master node via Supabase commands table
          await insertCommand('node-1', null, 'REGISTER_NODE_CATEGORY', {
            nodeId: config.nodeId,
            categoryId: nodeCatId,
          });
          logger.debug(`Announced Discord category [${nodeCatId}] for node '${config.nodeId}' to master via Supabase`);

          // 2. Direct HTTP call if master node URL is registered
          const nodes = await getAllNodes();
          const master = nodes.find((n: any) => n.id === 'node-1' || n.name?.toLowerCase().includes('master'));
          if (master && master.url) {
            const axios = require('axios');
            await axios.post(
              `${master.url}/api/internal/register-node-category`,
              { nodeId: config.nodeId, categoryId: nodeCatId },
              { timeout: 5000 }
            );
            logger.debug(`Announced Discord category [${nodeCatId}] to master via HTTP (${master.url})`);
          }
        } catch (err: any) {
          logger.debug(`Node category announcement: ${err?.message || err}`);
        }
      };

      announceCategory().catch(() => {});
      // Re-announce every 2 minutes so master always has category even across restarts
      setInterval(() => {
        announceCategory().catch(() => {});
      }, 120000);
    }
  }

  // ── Graceful shutdown (with guard) ──────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(heartbeatTimer);
    manager.stopStatusSync();
    manager.stopCommandPolling();
    try { await markNodeOffline(config.nodeId); } catch {}
    try { await manager.disconnectAll(); } catch {}
    logger.info('Shutdown complete. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error', undefined, err);
  process.exit(1);
});
