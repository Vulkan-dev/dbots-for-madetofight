import { Pool } from 'pg';
import { logger } from '../utils/logger';

let _pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!_pool) {
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.SUPABASE_URL;

    if (!connectionString) {
      logger.warn('DATABASE_URL or POSTGRES_URL is not set. Database functions will fail until configured.');
    }

    _pool = new Pool({
      connectionString: connectionString || 'postgresql://localhost:5432/railway',
      ssl: connectionString && (connectionString.includes('localhost') || connectionString.includes('127.0.0.1'))
        ? false
        : { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    _pool.on('error', (err) => {
      logger.error('Unexpected error on idle PostgreSQL client', undefined, err);
    });

    logger.info('Railway PostgreSQL pool initialized');
  }
  return _pool;
}

export async function initDatabaseSchema(): Promise<void> {
  const pool = getDbPool();
  try {
    await pool.query(`
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

      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS group_name TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_crouching BOOLEAN DEFAULT false;

      CREATE TABLE IF NOT EXISTS auth_tokens (
        account_id TEXT PRIMARY KEY,
        node_id TEXT,
        file_name TEXT DEFAULT '__bundle__',
        token_data TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS commands (
        id BIGSERIAL PRIMARY KEY,
        node_id TEXT NOT NULL,
        account_id TEXT,
        action TEXT NOT NULL,
        payload JSONB DEFAULT '{}'::jsonb,
        status TEXT DEFAULT 'PENDING',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

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

      CREATE TABLE IF NOT EXISTS permissions (
        user_id TEXT PRIMARY KEY,
        tag TEXT NOT NULL,
        node_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ignore_list (
        player_name TEXT PRIMARY KEY,
        node_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_node_id ON accounts(node_id);
      CREATE INDEX IF NOT EXISTS idx_commands_node_status ON commands(node_id, status);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_node_id ON auth_tokens(node_id);
    `);
    logger.info('Railway PostgreSQL schema verified successfully');
  } catch (err: any) {
    logger.error('PostgreSQL schema initialization error:', undefined, err);
  }
}

// ─── Node Registry ──────────────────────────────────────────────────────────────
export async function registerNode(id: string, name: string, url: string, owner: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO backend_nodes (id, name, url, owner, status, last_heartbeat)
     VALUES ($1, $2, $3, $4, 'online', NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       url = EXCLUDED.url,
       owner = EXCLUDED.owner,
       status = 'online',
       last_heartbeat = NOW()`,
    [id, name, url, owner]
  );
}

export async function heartbeatNode(id: string, botCount: number): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE backend_nodes SET status = 'online', bot_count = $2, last_heartbeat = NOW() WHERE id = $1`,
    [id, botCount]
  );
}

export async function markNodeOffline(id: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(`UPDATE backend_nodes SET status = 'offline' WHERE id = $1`, [id]);
}

export async function getAllNodes(): Promise<any[]> {
  const pool = getDbPool();
  const res = await pool.query(`SELECT * FROM backend_nodes ORDER BY created_at ASC`);
  return res.rows || [];
}

// ─── Accounts ───────────────────────────────────────────────────────────────────
export async function getAccountsForNode(nodeId: string): Promise<any[]> {
  const pool = getDbPool();
  const res = await pool.query(`SELECT * FROM accounts WHERE node_id = $1`, [nodeId]);
  return res.rows || [];
}

export async function getAllAccounts(): Promise<any[]> {
  const pool = getDbPool();
  const res = await pool.query(`SELECT * FROM accounts`);
  return res.rows || [];
}

export async function getAccountById(id: string): Promise<any | null> {
  const pool = getDbPool();
  const res = await pool.query(`SELECT * FROM accounts WHERE id = $1 LIMIT 1`, [id]);
  return res.rows[0] || null;
}

export async function upsertAccount(account: Record<string, any>): Promise<void> {
  const pool = getDbPool();
  const keys = Object.keys(account).filter(k => account[k] !== undefined);
  if (keys.length === 0) return;

  const cols = keys.map(k => `"${k}"`).join(', ');
  const params = keys.map((_, i) => `$${i + 1}`).join(', ');
  const updateClause = keys
    .filter(k => k !== 'id')
    .map((k, i) => `"${k}" = EXCLUDED."${k}"`)
    .join(', ');

  const query = `
    INSERT INTO accounts (${cols}, updated_at)
    VALUES (${params}, NOW())
    ON CONFLICT (id) DO UPDATE SET ${updateClause}, updated_at = NOW()
  `;

  const values = keys.map(k => {
    const val = account[k];
    if (typeof val === 'object' && val !== null) return JSON.stringify(val);
    return val;
  });

  await pool.query(query, values);
}

export async function updateAccountFields(id: string, fields: Record<string, any>): Promise<void> {
  const pool = getDbPool();
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (keys.length === 0) return;

  const setClause = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const values = keys.map(k => {
    const val = fields[k];
    if (typeof val === 'object' && val !== null) return JSON.stringify(val);
    return val;
  });

  await pool.query(
    `UPDATE accounts SET ${setClause}, updated_at = NOW() WHERE id = $1`,
    [id, ...values]
  );
}

export async function setAccountGroup(accountIds: string[], groupName: string | null): Promise<void> {
  const pool = getDbPool();
  const cleanName = groupName ? groupName.trim() : null;
  await pool.query(
    `UPDATE accounts SET group_name = $1, updated_at = NOW() WHERE id = ANY($2::text[])`,
    [cleanName, accountIds]
  );
}

export async function renameAccountGroup(oldName: string, newName: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE accounts SET group_name = $1, updated_at = NOW() WHERE group_name = $2`,
    [newName.trim(), oldName.trim()]
  );
}

export async function ungroupAccounts(groupName?: string, accountIds?: string[]): Promise<void> {
  const pool = getDbPool();
  if (Array.isArray(accountIds) && accountIds.length > 0) {
    await pool.query(
      `UPDATE accounts SET group_name = NULL, updated_at = NOW() WHERE id = ANY($1::text[])`,
      [accountIds]
    );
  } else if (groupName) {
    await pool.query(
      `UPDATE accounts SET group_name = NULL, updated_at = NOW() WHERE group_name = $1`,
      [groupName.trim()]
    );
  }
}

export async function deleteAccount(id: string, nodeId?: string): Promise<void> {
  const pool = getDbPool();
  if (nodeId) {
    await pool.query(`DELETE FROM accounts WHERE id = $1 AND node_id = $2`, [id, nodeId]);
  } else {
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
  }
  await pool.query(`DELETE FROM auth_tokens WHERE account_id = $1`, [id]);
  await pool.query(`DELETE FROM commands WHERE account_id = $1`, [id]);
}

// ─── Auth Tokens ────────────────────────────────────────────────────────────────
export async function saveAuthToken(accountId: string, nodeId: string, fileName: string, tokenData: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO auth_tokens (account_id, node_id, file_name, token_data, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (account_id) DO UPDATE SET
       node_id = EXCLUDED.node_id,
       file_name = EXCLUDED.file_name,
       token_data = EXCLUDED.token_data,
       updated_at = NOW()`,
    [accountId, nodeId, fileName, tokenData]
  );
}

export async function loadAuthToken(accountId: string): Promise<{ file_name: string; token_data: string } | null> {
  const pool = getDbPool();
  const res = await pool.query(
    `SELECT file_name, token_data FROM auth_tokens WHERE account_id = $1 LIMIT 1`,
    [accountId]
  );
  return res.rows[0] || null;
}

export async function deleteAuthToken(accountId: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(`DELETE FROM auth_tokens WHERE account_id = $1`, [accountId]);
}

export async function transferAuthToken(accountId: string, newNodeId: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE auth_tokens SET node_id = $1, updated_at = NOW() WHERE account_id = $2`,
    [newNodeId, accountId]
  );
}

// ─── Commands ───────────────────────────────────────────────────────────────────
export async function getPendingCommands(nodeId: string): Promise<any[]> {
  const pool = getDbPool();
  const res = await pool.query(
    `SELECT * FROM commands WHERE node_id = $1 AND status = 'PENDING' ORDER BY created_at ASC LIMIT 20`,
    [nodeId]
  );
  return res.rows || [];
}

export async function markCommandDone(id: string, status: 'DONE' | 'FAILED' = 'DONE'): Promise<void> {
  const pool = getDbPool();
  await pool.query(`UPDATE commands SET status = $2 WHERE id = $1`, [id, status]);
}

export async function insertCommand(nodeId: string, accountId: string | null, action: string, payload: any = {}): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO commands (node_id, account_id, action, payload, status) VALUES ($1, $2, $3, $4, 'PENDING')`,
    [nodeId, accountId, action, JSON.stringify(payload)]
  );
}

// ─── Node Settings ──────────────────────────────────────────────────────────────
export async function getNodeSettings(nodeId: string): Promise<any | null> {
  const pool = getDbPool();
  const res = await pool.query(`SELECT * FROM node_settings WHERE node_id = $1 LIMIT 1`, [nodeId]);
  return res.rows[0] || null;
}

export async function upsertNodeSettings(nodeId: string, settings: Record<string, any>): Promise<void> {
  const pool = getDbPool();
  const keys = Object.keys(settings).filter(k => k !== 'node_id' && settings[k] !== undefined);
  const cols = ['node_id', ...keys].map(k => `"${k}"`).join(', ');
  const params = ['$1', ...keys.map((_, i) => `$${i + 2}`)].join(', ');
  const updateClause = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');

  const values = [nodeId, ...keys.map(k => settings[k])];
  await pool.query(
    `INSERT INTO node_settings (${cols}, updated_at) VALUES (${params}, NOW())
     ON CONFLICT (node_id) DO UPDATE SET ${updateClause}, updated_at = NOW()`,
    values
  );
}

// ─── Permissions ────────────────────────────────────────────────────────────────
export async function getPermissions(nodeId: string): Promise<{ user_id: string; tag: string }[]> {
  const pool = getDbPool();
  const res = await pool.query(`SELECT user_id, tag FROM permissions WHERE node_id = $1`, [nodeId]);
  return res.rows || [];
}

export async function addPermission(nodeId: string, userId: string, tag: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO permissions (user_id, tag, node_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET tag = EXCLUDED.tag, node_id = EXCLUDED.node_id`,
    [userId, tag, nodeId]
  );
}

export async function removePermission(userId: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(`DELETE FROM permissions WHERE user_id = $1`, [userId]);
}

// ─── Ignore List ────────────────────────────────────────────────────────────────
export async function getIgnoreList(nodeId?: string): Promise<string[]> {
  const pool = getDbPool();
  let query = `SELECT player_name FROM ignore_list`;
  const params: any[] = [];
  if (nodeId) {
    query += ` WHERE node_id = $1 OR node_id IS NULL`;
    params.push(nodeId);
  }
  const res = await pool.query(query, params);
  return (res.rows || []).map(r => r.player_name);
}

export async function addToIgnoreList(nodeId: string, playerName: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO ignore_list (player_name, node_id) VALUES ($1, $2)
     ON CONFLICT (player_name) DO UPDATE SET node_id = EXCLUDED.node_id`,
    [playerName.toLowerCase(), nodeId]
  );
}

export async function removeFromIgnoreList(playerName: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(`DELETE FROM ignore_list WHERE player_name = $1`, [playerName.toLowerCase()]);
}

// ─── Registered Node Categories ────────────────────────────────────────────────
export async function getRegisteredNodeCategories(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const pool = getDbPool();
    const res = await pool.query(
      `SELECT payload FROM commands WHERE action = 'REGISTER_NODE_CATEGORY' ORDER BY created_at DESC`
    );
    for (const row of res.rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (payload?.nodeId && payload?.categoryId && !map.has(payload.nodeId)) {
        map.set(payload.nodeId, payload.categoryId);
      }
    }
  } catch (err: any) {
    logger.debug(`getRegisteredNodeCategories error: ${err?.message}`);
  }
  return map;
}

// ─── System Backup & Restore ───────────────────────────────────────────────────
export async function exportAllBackupData(): Promise<{
  accounts: any[];
  nodes: any[];
  tokens: any[];
  settings?: any[];
  permissions?: any[];
  ignoreList?: any[];
  commands?: any[];
  accountGroups?: any[];
}> {
  const pool = getDbPool();
  const [accRes, nodesRes, tokensRes, settingsRes, permsRes, ignoreRes, cmdRes] = await Promise.all([
    pool.query(`SELECT * FROM accounts`),
    pool.query(`SELECT * FROM backend_nodes`),
    pool.query(`SELECT * FROM auth_tokens`),
    pool.query(`SELECT * FROM node_settings`),
    pool.query(`SELECT * FROM permissions`),
    pool.query(`SELECT * FROM ignore_list`),
    pool.query(`SELECT * FROM commands WHERE action = 'SET_ACCOUNT_GROUPS'`),
  ]);

  let accountGroups: any[] = [];
  if (cmdRes.rows && cmdRes.rows.length > 0) {
    const latest = cmdRes.rows[cmdRes.rows.length - 1];
    const payload = typeof latest.payload === 'string' ? JSON.parse(latest.payload) : latest.payload;
    if (Array.isArray(payload?.groups)) {
      accountGroups = payload.groups;
    }
  }

  return {
    accounts: accRes.rows || [],
    nodes: nodesRes.rows || [],
    tokens: tokensRes.rows || [],
    settings: settingsRes.rows || [],
    permissions: permsRes.rows || [],
    ignoreList: ignoreRes.rows || [],
    commands: cmdRes.rows || [],
    accountGroups,
  };
}

export async function importAllBackupData(backup: any): Promise<{
  accountsCount: number;
  nodesCount: number;
  tokensCount: number;
  settingsCount: number;
  permissionsCount: number;
  ignoreListCount: number;
}> {
  const accounts = backup.accounts || [];
  const nodes = backup.nodes || [];
  const tokens = backup.tokens || [];
  const settings = backup.settings || [];
  const permissions = backup.permissions || [];
  const ignoreList = backup.ignoreList || [];

  if (accounts.length > 0 || tokens.length > 0) {
    await clearDatabaseTables({ clearAccounts: true });
  }

  for (const n of nodes) {
    await registerNode(n.id, n.name, n.url, n.owner || '');
  }
  for (const acc of accounts) {
    await upsertAccount(acc);
  }
  for (const tok of tokens) {
    await saveAuthToken(tok.account_id, tok.node_id, tok.file_name || '__bundle__', typeof tok.token_data === 'object' ? JSON.stringify(tok.token_data) : tok.token_data);
  }
  for (const s of settings) {
    await upsertNodeSettings(s.node_id, s);
  }
  for (const p of permissions) {
    await addPermission(p.node_id, p.user_id, p.tag);
  }
  for (const ig of ignoreList) {
    await addToIgnoreList(ig.node_id || 'node-1', ig.player_name);
  }

  return {
    accountsCount: accounts.length,
    nodesCount: nodes.length,
    tokensCount: tokens.length,
    settingsCount: settings.length,
    permissionsCount: permissions.length,
    ignoreListCount: ignoreList.length,
  };
}

// ─── Dual Backup Compatibility Stubs ──────────────────────────────────────────
let _lastSecondarySyncStatus: any = null;

export function getSecondarySupabaseClient(): any {
  return null;
}

export function getLastSecondarySyncStatus(): any {
  return _lastSecondarySyncStatus;
}

export async function syncToSecondarySupabase(): Promise<{ success: boolean; counts: any; error?: string }> {
  return {
    success: true,
    counts: { nodes: 0, accounts: 0, tokens: 0, settings: 0, permissions: 0, ignoreList: 0 },
  };
}

export async function loadFromSecondarySupabase(): Promise<{ success: boolean; data?: any; counts: any; error?: string }> {
  return {
    success: false,
    error: 'Secondary database backup not configured',
    counts: { nodes: 0, accounts: 0, tokens: 0, settings: 0, permissions: 0, ignoreList: 0 },
  };
}

export async function clearDatabaseTables(options: { clearAccounts?: boolean; clearNodes?: boolean; preserveNodeId?: string }): Promise<{ success: boolean; error?: string }> {
  const pool = getDbPool();
  try {
    if (options.clearAccounts) {
      await pool.query(`DELETE FROM auth_tokens`);
      await pool.query(`DELETE FROM commands`);
      await pool.query(`DELETE FROM accounts`);
    }
    if (options.clearNodes) {
      if (options.preserveNodeId) {
        await pool.query(`DELETE FROM backend_nodes WHERE id != $1`, [options.preserveNodeId]);
      } else {
        await pool.query(`DELETE FROM backend_nodes`);
      }
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
}
