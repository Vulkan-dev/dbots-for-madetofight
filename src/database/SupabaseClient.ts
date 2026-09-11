import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

// ─── Schema SQL ────────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS backend_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline',
  bot_count INT NOT NULL DEFAULT 0,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DISCONNECTED',
  ign TEXT NOT NULL DEFAULT '',
  gamertag TEXT NOT NULL DEFAULT '',
  health NUMERIC NOT NULL DEFAULT 20,
  pos_x NUMERIC NOT NULL DEFAULT 0,
  pos_y NUMERIC NOT NULL DEFAULT 0,
  pos_z NUMERIC NOT NULL DEFAULT 0,
  afk_spot_active BOOLEAN NOT NULL DEFAULT false,
  afk_spot JSONB,
  msa_code TEXT,
  msa_url TEXT,
  msa_direct_url TEXT,
  auth_status TEXT NOT NULL DEFAULT 'IDLE',
  auth_error TEXT,
  auto_connect BOOLEAN NOT NULL DEFAULT true,
  offline_mode BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  account_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  token_data TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id TEXT NOT NULL,
  account_id TEXT,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_settings (
  node_id TEXT PRIMARY KEY,
  afk_enabled BOOLEAN NOT NULL DEFAULT true,
  afk_interval_ms INT NOT NULL DEFAULT 5000,
  afk_check_interval_ms INT NOT NULL DEFAULT 300000,
  afk_location_tolerance NUMERIC NOT NULL DEFAULT 3.0,
  defensive_combat_enabled BOOLEAN NOT NULL DEFAULT false,
  defensive_combat_range NUMERIC NOT NULL DEFAULT 4.5,
  player_hit_response_enabled BOOLEAN NOT NULL DEFAULT false,
  player_hit_response_crouch_count INT NOT NULL DEFAULT 2,
  server_host TEXT NOT NULL DEFAULT 'donutsmp.net',
  server_port INT NOT NULL DEFAULT 19132,
  server_offline BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
  user_id TEXT PRIMARY KEY,
  tag TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ignore_list (
  player_name TEXT PRIMARY KEY,
  node_id TEXT NOT NULL DEFAULT '',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_node ON accounts(node_id);
CREATE INDEX IF NOT EXISTS idx_commands_node_status ON commands(node_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_node ON auth_tokens(node_id);
`;

// ─── Singleton ─────────────────────────────────────────────────────────────────
let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required environment variables');
    }
    _client = createClient(url, key, { auth: { persistSession: false } });
    logger.info('Supabase client initialized');
  }
  return _client;
}

// ─── Schema Init ────────────────────────────────────────────────────────────────
export async function initSupabaseSchema(): Promise<void> {
  const client = getSupabaseClient();
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
  for (const sql of statements) {
    let error = null;
    try {
      const result = await client.rpc('exec_sql', { query: sql + ';' });
      error = result.error;
    } catch {
      error = null;
    }
    if (error) {
      // Use pg directly as fallback if exec_sql RPC is not available
      logger.debug(`Schema init via RPC: ${error.message || error}`);
    }
  }
  logger.info('Supabase schema initialized');
}

// ─── Node Registry ──────────────────────────────────────────────────────────────
export async function registerNode(id: string, name: string, url: string, owner: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('backend_nodes').upsert({
    id, name, url, owner, status: 'online',
    last_heartbeat: new Date().toISOString(),
  }, { onConflict: 'id' });
}

export async function heartbeatNode(id: string, botCount: number): Promise<void> {
  const client = getSupabaseClient();
  await client.from('backend_nodes').update({
    status: 'online',
    bot_count: botCount,
    last_heartbeat: new Date().toISOString(),
  }).eq('id', id);
}

export async function markNodeOffline(id: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('backend_nodes').update({ status: 'offline' }).eq('id', id);
}

export async function getAllNodes(): Promise<any[]> {
  const client = getSupabaseClient();
  const { data } = await client.from('backend_nodes').select('*').order('created_at');
  return data || [];
}

// ─── Accounts ───────────────────────────────────────────────────────────────────
export async function getAccountsForNode(nodeId: string): Promise<any[]> {
  const client = getSupabaseClient();
  const { data, error } = await client.from('accounts').select('*').eq('node_id', nodeId);
  if (error) logger.debug(`getAccountsForNode: ${error.message}`);
  return data || [];
}

export async function getAllAccounts(): Promise<any[]> {
  const client = getSupabaseClient();
  const { data } = await client.from('accounts').select('*');
  return data || [];
}

export async function upsertAccount(account: {
  id: string; node_id: string; email?: string; status?: string;
  ign?: string; gamertag?: string; health?: number;
  pos_x?: number; pos_y?: number; pos_z?: number;
  afk_spot_active?: boolean; afk_spot?: any;
  msa_code?: string | null; msa_url?: string | null; msa_direct_url?: string | null;
  auth_status?: string; auth_error?: string | null;
  auto_connect?: boolean; offline_mode?: boolean;
}): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from('accounts').upsert({
    ...account,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) logger.debug(`upsertAccount [${account.id}]: ${error.message}`);
}

export async function deleteAccount(id: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('accounts').delete().eq('id', id);
  await client.from('auth_tokens').delete().eq('account_id', id);
  await client.from('commands').delete().eq('account_id', id);
}

// ─── Auth Tokens ────────────────────────────────────────────────────────────────
export async function saveAuthToken(accountId: string, nodeId: string, fileName: string, tokenData: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('auth_tokens').upsert({
    account_id: accountId,
    node_id: nodeId,
    file_name: fileName,
    token_data: tokenData,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_id' });
}

export async function loadAuthToken(accountId: string): Promise<{ file_name: string; token_data: string } | null> {
  const client = getSupabaseClient();
  const { data } = await client.from('auth_tokens').select('file_name,token_data').eq('account_id', accountId).single();
  return data || null;
}

export async function deleteAuthToken(accountId: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('auth_tokens').delete().eq('account_id', accountId);
}

// ─── Commands ───────────────────────────────────────────────────────────────────
export async function getPendingCommands(nodeId: string): Promise<any[]> {
  const client = getSupabaseClient();
  const { data } = await client
    .from('commands')
    .select('*')
    .eq('node_id', nodeId)
    .eq('status', 'PENDING')
    .order('created_at')
    .limit(20);
  return data || [];
}

export async function markCommandDone(id: string, status: 'DONE' | 'FAILED' = 'DONE'): Promise<void> {
  const client = getSupabaseClient();
  await client.from('commands').update({ status }).eq('id', id);
}

export async function insertCommand(nodeId: string, accountId: string | null, action: string, payload: any = {}): Promise<void> {
  const client = getSupabaseClient();
  await client.from('commands').insert({ node_id: nodeId, account_id: accountId, action, payload });
}

// ─── Node Settings ──────────────────────────────────────────────────────────────
export async function getNodeSettings(nodeId: string): Promise<any | null> {
  const client = getSupabaseClient();
  const { data } = await client.from('node_settings').select('*').eq('node_id', nodeId).single();
  return data || null;
}

export async function upsertNodeSettings(nodeId: string, settings: Record<string, any>): Promise<void> {
  const client = getSupabaseClient();
  await client.from('node_settings').upsert({
    node_id: nodeId,
    ...settings,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'node_id' });
}

// ─── Permissions ────────────────────────────────────────────────────────────────
export async function getPermissions(nodeId: string): Promise<{ user_id: string; tag: string }[]> {
  const client = getSupabaseClient();
  const { data } = await client.from('permissions').select('user_id,tag').eq('node_id', nodeId);
  return data || [];
}

export async function addPermission(nodeId: string, userId: string, tag: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('permissions').upsert({ user_id: userId, tag, node_id: nodeId }, { onConflict: 'user_id' });
}

export async function removePermission(userId: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('permissions').delete().eq('user_id', userId);
}

// ─── Ignore List ────────────────────────────────────────────────────────────────
export async function getIgnoreList(nodeId: string): Promise<string[]> {
  const client = getSupabaseClient();
  const { data } = await client.from('ignore_list').select('player_name').eq('node_id', nodeId);
  return (data || []).map((r: any) => r.player_name);
}

export async function addToIgnoreList(nodeId: string, playerName: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('ignore_list').upsert({
    player_name: playerName.toLowerCase(),
    node_id: nodeId,
  }, { onConflict: 'player_name' });
}

export async function removeFromIgnoreList(playerName: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('ignore_list').delete().eq('player_name', playerName.toLowerCase());
}
