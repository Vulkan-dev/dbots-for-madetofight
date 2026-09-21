-- ====================================================================
-- DONUT SMP BEDROCK BOT — SUPABASE DATABASE SCHEMA
-- Run this in both Primary and Secondary Supabase SQL Editors
-- ====================================================================

-- 1. Nodes registry
CREATE TABLE IF NOT EXISTS backend_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  owner TEXT DEFAULT '',
  status TEXT DEFAULT 'online',
  bot_count INTEGER DEFAULT 0,
  last_heartbeat TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  node_id TEXT,
  email TEXT DEFAULT '',
  status TEXT DEFAULT 'IDLE',
  ign TEXT DEFAULT '',
  gamertag TEXT DEFAULT '',
  health NUMERIC DEFAULT 20,
  pos_x NUMERIC DEFAULT 0,
  pos_y NUMERIC DEFAULT 64,
  pos_z NUMERIC DEFAULT 0,
  afk_spot_active BOOLEAN DEFAULT false,
  afk_spot JSONB,
  msa_code TEXT,
  msa_url TEXT,
  msa_direct_url TEXT,
  auth_status TEXT DEFAULT 'IDLE',
  auth_error TEXT,
  auto_connect BOOLEAN DEFAULT false,
  offline_mode BOOLEAN DEFAULT false,
  group_name TEXT,
  is_crouching BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent column migrations
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_crouching BOOLEAN DEFAULT false;

-- 3. Auth Tokens
CREATE TABLE IF NOT EXISTS auth_tokens (
  account_id TEXT PRIMARY KEY,
  node_id TEXT,
  file_name TEXT DEFAULT '__bundle__',
  token_data TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Commands Bus
CREATE TABLE IF NOT EXISTS commands (
  id BIGSERIAL PRIMARY KEY,
  node_id TEXT NOT NULL,
  account_id TEXT,
  action TEXT NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Node Settings
CREATE TABLE IF NOT EXISTS node_settings (
  node_id TEXT PRIMARY KEY,
  afk_enabled BOOLEAN DEFAULT true,
  afk_interval_ms INTEGER DEFAULT 5000,
  afk_check_interval_ms INTEGER DEFAULT 300000,
  afk_location_tolerance NUMERIC DEFAULT 3.0,
  defensive_combat_enabled BOOLEAN DEFAULT false,
  defensive_combat_range NUMERIC DEFAULT 4.5,
  player_hit_response_enabled BOOLEAN DEFAULT false,
  player_hit_response_crouch_count INTEGER DEFAULT 2,
  server_host TEXT DEFAULT 'donutsmp.net',
  server_port INTEGER DEFAULT 19132,
  server_offline BOOLEAN DEFAULT false,
  webhook_endpoint TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Permissions
CREATE TABLE IF NOT EXISTS permissions (
  user_id TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  node_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Ignore List (Trusted Radar Whitelist)
CREATE TABLE IF NOT EXISTS ignore_list (
  player_name TEXT PRIMARY KEY,
  node_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for high-frequency queries
CREATE INDEX IF NOT EXISTS idx_accounts_node_id ON accounts(node_id);
CREATE INDEX IF NOT EXISTS idx_commands_node_status ON commands(node_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_node_id ON auth_tokens(node_id);

-- Disable Row Level Security (RLS) so the frontend anon key and backend can read and write
ALTER TABLE backend_nodes DISABLE ROW LEVEL SECURITY;
ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE commands DISABLE ROW LEVEL SECURITY;
ALTER TABLE node_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE permissions DISABLE ROW LEVEL SECURITY;
ALTER TABLE ignore_list DISABLE ROW LEVEL SECURITY;
