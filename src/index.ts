import dotenv from 'dotenv';
dotenv.config();
import './auth/patchPrismarineAuth';

import { loadConfig } from './config';
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
} from './database/SupabaseClient';
import { applyNodeSettings } from './config';

// ── Global error guards ──────────────────────────────────────────────────────
process.on('uncaughtException', (err: any) => {
  const msg = err?.message || err?.toString() || '';
  if (msg.includes('Invalid tag') || msg.includes('Read error') || msg.includes('Deserialization')) {
    logger.debug(`Suppressed non-fatal library deserialization exception: ${msg}`);
    return;
  }
  logger.error('Uncaught exception', undefined, err);
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled promise rejection', undefined, reason);
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
====================================================================
`);

  // ── Supabase schema init ────────────────────────────────────────────────────
  logger.info('Initializing Supabase schema...');
  await initSupabaseSchema();

  // ── Register this node in Supabase ──────────────────────────────────────────
  await registerNode(config.nodeId, config.nodeName, config.nodeUrl, config.nodeOwner);
  logger.info(`Node '${config.nodeId}' registered in Supabase`);

  // ── Load node settings from Supabase ────────────────────────────────────────
  const savedSettings = await getNodeSettings(config.nodeId);
  if (savedSettings) {
    applyNodeSettings(savedSettings);
    logger.info('Applied node settings from Supabase');
  }

  // ── Account Manager + load accounts from Supabase ──────────────────────────
  const manager = new AccountManager(config);
  await manager.loadAccountsFromSupabase();
  logger.info(`Loaded ${manager.getAllBots().length} bot(s) from Supabase`);

  // ── Auto-connect bots ───────────────────────────────────────────────────────
  manager.connectAutoConnectAccounts();

  // ── Start Supabase status sync & command polling ────────────────────────────
  manager.startStatusSync(5000);
  manager.startCommandPolling(2000);

  // ── Web API server ──────────────────────────────────────────────────────────
  const webServer = new WebServer(manager, config);
  webServer.start();

  // ── Heartbeat — keeps this node's status green in Supabase ──────────────────
  const heartbeatTimer = setInterval(async () => {
    try {
      await heartbeatNode(config.nodeId, manager.getAllBots().length);
    } catch {}
  }, 30000);

  // ── Discord Bot (only on master node) ──────────────────────────────────────
  let discordBot: DiscordBot | null = null;
  if (config.discord.isMaster && config.discord.token) {
    discordBot = new DiscordBot(manager, config);
    await discordBot.start();
    logger.info('Discord master bot started — controlling all nodes via Supabase');
  } else if (config.discord.isMaster && !config.discord.token) {
    logger.warn('DISCORD_MASTER=true but DISCORD_TOKEN is not set. Discord bot disabled.');
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.warn(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(heartbeatTimer);
    manager.stopStatusSync();
    manager.stopCommandPolling();
    await markNodeOffline(config.nodeId);
    await manager.disconnectAll();
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
