import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

// ─── Singleton ─────────────────────────────────────────────────────────────────
let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required environment variables');
    }
    _client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    logger.info('Supabase client initialized');
  }
  return _client;
}

// ─── Schema Init ────────────────────────────────────────────────────────────────
// Tables must be created manually in Supabase SQL Editor before first run.
// See the SQL in the project README or run the provided schema.sql.
export async function initSupabaseSchema(): Promise<void> {
  const client = getSupabaseClient();
  try {
    const { error } = await client.from('backend_nodes').select('id').limit(1);
    if (error) {
      logger.error(`Supabase schema check failed — make sure tables exist. Error: ${error.message} (code: ${error.code})`);
      logger.error('Run the schema SQL in Supabase SQL Editor. See README for the SQL.');
    } else {
      logger.info('Supabase schema verified');
    }
  } catch (err) {
    logger.error('Supabase schema check threw', undefined, err);
  }
}

// ─── Node Registry ──────────────────────────────────────────────────────────────
export async function registerNode(id: string, name: string, url: string, owner: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from('backend_nodes').upsert({
    id, name, url, owner, status: 'online',
    last_heartbeat: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) {
    throw new Error(`Failed to register node '${id}': ${error.message} (code: ${error.code})`);
  }
}

export async function heartbeatNode(id: string, botCount: number): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from('backend_nodes').update({
    status: 'online',
    bot_count: botCount,
    last_heartbeat: new Date().toISOString(),
  }).eq('id', id);
  if (error) {
    logger.debug(`Heartbeat failed for '${id}': ${error.message}`);
  }
}

export async function markNodeOffline(id: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from('backend_nodes').update({ status: 'offline' }).eq('id', id);
  if (error) {
    logger.debug(`markNodeOffline failed for '${id}': ${error.message}`);
  }
}

export async function getAllNodes(): Promise<any[]> {
  const client = getSupabaseClient();
  const { data, error } = await client.from('backend_nodes').select('*').order('created_at');
  if (error) {
    logger.debug(`getAllNodes: ${error.message}`);
    return [];
  }
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
  const { data, error } = await client.from('accounts').select('*');
  if (error) logger.debug(`getAllAccounts: ${error.message}`);
  return data || [];
}

export async function getAccountById(id: string): Promise<any | null> {
  const client = getSupabaseClient();
  const { data, error } = await client.from('accounts').select('*').eq('id', id).maybeSingle();
  if (error) logger.debug(`getAccountById [${id}]: ${error.message}`);
  return data || null;
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
  const cleanAccount: Record<string, any> = {
    ...account,
    updated_at: new Date().toISOString(),
  };
  // Remove explicitly undefined values so they don't overwrite existing columns with defaults
  Object.keys(cleanAccount).forEach(k => cleanAccount[k] === undefined && delete cleanAccount[k]);

  const { error } = await client.from('accounts').upsert(cleanAccount, { onConflict: 'id' });
  if (error) logger.debug(`upsertAccount [${account.id}]: ${error.message}`);
}

export async function updateAccountFields(id: string, fields: Record<string, any>): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from('accounts').update({
    ...fields,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) logger.debug(`updateAccountFields [${id}]: ${error.message}`);
}

export async function deleteAccount(id: string, nodeId?: string): Promise<void> {
  const client = getSupabaseClient();
  let query = client.from('accounts').delete().eq('id', id);
  if (nodeId) query = query.eq('node_id', nodeId);
  await query;
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
  const { data, error } = await client.from('auth_tokens').select('file_name,token_data').eq('account_id', accountId).maybeSingle();
  if (error) logger.debug(`loadAuthToken [${accountId}]: ${error.message}`);
  return data || null;
}

export async function deleteAuthToken(accountId: string): Promise<void> {
  const client = getSupabaseClient();
  await client.from('auth_tokens').delete().eq('account_id', accountId);
}

export async function transferAuthToken(accountId: string, newNodeId: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from('auth_tokens').update({
    node_id: newNodeId,
    updated_at: new Date().toISOString(),
  }).eq('account_id', accountId);
  if (error) logger.debug(`transferAuthToken [${accountId}]: ${error.message}`);
}

// ─── Commands ───────────────────────────────────────────────────────────────────
export async function getPendingCommands(nodeId: string): Promise<any[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('commands')
    .select('*')
    .eq('node_id', nodeId)
    .eq('status', 'PENDING')
    .order('created_at')
    .limit(20);
  if (error) logger.debug(`getPendingCommands: ${error.message}`);
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
  const { data, error } = await client.from('node_settings').select('*').eq('node_id', nodeId).maybeSingle();
  if (error && error.code !== 'PGRST116') logger.debug(`getNodeSettings: ${error.message}`);
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
  const { data, error } = await client.from('permissions').select('user_id,tag').eq('node_id', nodeId);
  if (error) logger.debug(`getPermissions: ${error.message}`);
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
  const { data, error } = await client.from('ignore_list').select('player_name').eq('node_id', nodeId);
  if (error) logger.debug(`getIgnoreList: ${error.message}`);
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
