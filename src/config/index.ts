import { logger } from '../utils/logger';

// ─── Pure environment-variable config ─────────────────────────────────────────
// No config.yaml, no file reading. All configuration comes from env vars.
// Set these in Railway dashboard (or .env for local development).
// ──────────────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

function optionalInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function optionalFloat(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

// ─── Config Shape ──────────────────────────────────────────────────────────────
export interface AccountConfig {
  id: string;
  email: string;
  nodeId: string;
  autoConnect: boolean;
  offline: boolean;
  // profilesFolder is always a temp path managed by TokenStorage
  profilesFolder: string;
}

export interface AppConfig {
  // Identity
  nodeId: string;
  nodeName: string;
  nodeOwner: string;
  nodeUrl: string; // This Railway service's public URL (set manually in env or auto via RAILWAY_STATIC_URL)

  // Supabase (Primary)
  supabase: {
    url: string;
    serviceRoleKey: string;
  };

  // Secondary Supabase (Dual Supabase backup target)
  secondarySupabase?: {
    url: string;
    serviceRoleKey: string;
    anonKey?: string;
  };

  // Minecraft server
  server: {
    host: string;
    port: number;
    offline: boolean;
  };

  // Web server
  webServer: {
    port: number;
    frontendUrl: string; // CORS origin for Vercel
    apiSecret: string;   // Optional shared secret for securing API
  };

  // Discord (only used when DISCORD_MASTER=true)
  discord: {
    isMaster: boolean;
    token: string;
    botCategoryId: string;
    nodeBotCategoryId?: string;
    allowedUserId: string;
    logChannelId: string;
    joinLogChannelId: string;
    leftLogChannelId: string;
  };

  // AFK
  afk: {
    enabled: boolean;
    activityIntervalMs: number;
    checkIntervalMs: number;
    locationTolerance: number;
  };

  // Defensive combat
  defensiveCombat: {
    enabled: boolean;
    allowedMobs: string[];
    mobBlacklist: string[];
    combatRange: number;
  };

  // Player hit response
  playerHitResponse: {
    enabled: boolean;
    crouchCount: number;
    cooldownMs: number;
  };

  // Join scheduler
  joinScheduler: {
    minDelayMs: number;
    maxDelayMs: number;
  };

  // Watchdog
  watchdog: {
    reconnectDelayMs: number;
  };

  // Monitoring
  monitoring: {
    radiusChunks: number;
    positionThresholdBlocks: number;
  };
}

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const nodeId = optionalEnv('NODE_ID', `node-${require('os').hostname()}`);

  _config = {
    nodeId,
    nodeName: optionalEnv('NODE_NAME', `Railway Node ${nodeId}`),
    nodeOwner: optionalEnv('NODE_OWNER', ''),
    nodeUrl: optionalEnv(
      'NODE_URL',
      process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.RAILWAY_STATIC_URL
          ? `https://${process.env.RAILWAY_STATIC_URL}`
          : `http://localhost:${optionalInt('PORT', 3000)}`
    ),

    supabase: {
      url: requireEnv('SUPABASE_URL'),
      serviceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    },

    secondarySupabase: process.env.SECONDARY_SUPABASE_URL ? {
      url: process.env.SECONDARY_SUPABASE_URL.trim(),
      serviceRoleKey: (process.env.SECONDARY_SUPABASE_SERVICE_ROLE_KEY || '').trim(),
      anonKey: (process.env.SECONDARY_SUPABASE_ANON_KEY || '').trim(),
    } : undefined,

    server: {
      host: optionalEnv('SERVER_HOST', 'donutsmp.net'),
      port: optionalInt('SERVER_PORT', 19132),
      offline: optionalBool('OFFLINE_MODE', false),
    },

    webServer: {
      port: optionalInt('PORT', 3000),
      frontendUrl: optionalEnv('FRONTEND_URL', '*'),
      apiSecret: optionalEnv('API_SECRET', ''),
    },

    discord: {
      isMaster: optionalBool('DISCORD_MASTER', false),
      token: optionalEnv('DISCORD_TOKEN', ''),
      botCategoryId: optionalEnv('DISCORD_BOT_CATEGORY_ID', ''),
      nodeBotCategoryId: optionalEnv('NODE_DISCORD_BOT_CATEGORY_ID', ''),
      allowedUserId: optionalEnv('DISCORD_ALLOWED_USER_ID', ''),
      logChannelId: optionalEnv('DISCORD_LOG_CHANNEL_ID', ''),
      joinLogChannelId: optionalEnv('DISCORD_JOIN_LOG_CHANNEL_ID', ''),
      leftLogChannelId: optionalEnv('DISCORD_LEFT_LOG_CHANNEL_ID', ''),
    },

    afk: {
      enabled: optionalBool('AFK_ENABLED', true),
      activityIntervalMs: optionalInt('AFK_ACTIVITY_INTERVAL_MS', 5000),
      checkIntervalMs: optionalInt('AFK_CHECK_INTERVAL_MS', 300000),
      locationTolerance: optionalFloat('AFK_LOCATION_TOLERANCE', 10.0),
    },

    defensiveCombat: {
      enabled: optionalBool('DEFENSIVE_COMBAT_ENABLED', false),
      allowedMobs: (optionalEnv('DEFENSIVE_COMBAT_MOBS', 'zombie,skeleton,spider,creeper,drowned,husk,stray')).split(',').map(s => s.trim()).filter(Boolean),
      mobBlacklist: (optionalEnv('DEFENSIVE_COMBAT_BLACKLIST', 'wither,ender_dragon,warden,elder_guardian')).split(',').map(s => s.trim()).filter(Boolean),
      combatRange: optionalFloat('DEFENSIVE_COMBAT_RANGE', 4.5),
    },

    playerHitResponse: {
      enabled: optionalBool('PLAYER_HIT_RESPONSE_ENABLED', false),
      crouchCount: optionalInt('PLAYER_HIT_RESPONSE_CROUCH_COUNT', 2),
      cooldownMs: optionalInt('PLAYER_HIT_RESPONSE_COOLDOWN_MS', 3000),
    },

    joinScheduler: {
      minDelayMs: optionalInt('JOIN_SCHEDULER_MIN_DELAY_MS', 1000),
      maxDelayMs: optionalInt('JOIN_SCHEDULER_MAX_DELAY_MS', 2000),
    },

    watchdog: {
      reconnectDelayMs: optionalInt('WATCHDOG_RECONNECT_DELAY_MS', 1000),
    },

    monitoring: {
      radiusChunks: optionalInt('MONITORING_RADIUS_CHUNKS', 4),
      positionThresholdBlocks: optionalFloat('MONITORING_POSITION_THRESHOLD', 2.0),
    },
  };

  logger.info(`Config loaded — Node: ${_config.nodeId} | Server: ${_config.server.host}:${_config.server.port} | Discord Master: ${_config.discord.isMaster}`);
  return _config;
}

// Update in-memory config (for runtime toggles synced from Supabase node_settings)
export function applyNodeSettings(settings: Record<string, any>): void {
  if (!_config) return;
  if (typeof settings.afk_enabled === 'boolean') _config.afk.enabled = settings.afk_enabled;
  if (typeof settings.afk_interval_ms === 'number') _config.afk.activityIntervalMs = settings.afk_interval_ms;
  if (typeof settings.afk_check_interval_ms === 'number') _config.afk.checkIntervalMs = settings.afk_check_interval_ms;
  if (typeof settings.afk_location_tolerance === 'number') _config.afk.locationTolerance = settings.afk_location_tolerance;
  if (typeof settings.defensive_combat_enabled === 'boolean') _config.defensiveCombat.enabled = settings.defensive_combat_enabled;
  if (typeof settings.defensive_combat_range === 'number') _config.defensiveCombat.combatRange = settings.defensive_combat_range;
  if (typeof settings.player_hit_response_enabled === 'boolean') _config.playerHitResponse.enabled = settings.player_hit_response_enabled;
  if (typeof settings.player_hit_response_crouch_count === 'number') _config.playerHitResponse.crouchCount = settings.player_hit_response_crouch_count;
  if (typeof settings.server_host === 'string') _config.server.host = settings.server_host;
  if (typeof settings.server_port === 'number') _config.server.port = settings.server_port;
  if (typeof settings.server_offline === 'boolean') _config.server.offline = settings.server_offline;
}
