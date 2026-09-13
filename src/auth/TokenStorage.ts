import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';
import {
  saveAuthToken,
  loadAuthToken,
  getAllAuthTokens,
  deleteAuthToken,
  transferAuthToken,
  getAccountById,
  getAllAccounts,
  upsertAccount,
} from '../database/SupabaseClient';

// ─── Temp directory for prismarine-auth cache files ───────────────────────────
// Stored in temp dir and synchronized with Supabase.
// Deep validation and atomic writes prevent 0-byte or corrupted token files.
// ─────────────────────────────────────────────────────────────────────────────

const PROFILES_BASE = path.join(os.tmpdir(), 'donut-bot-profiles');

export class TokenStorage {
  /**
   * Validates that a string is non-empty, well-formed JSON containing actual data.
   */
  public static validateJson(content: string): boolean {
    if (!content || typeof content !== 'string') return false;
    const trimmed = content.trim();
    if (trimmed.length < 10 || trimmed === '{}' || trimmed === '[]') return false;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Atomically writes data to a file by writing to a .tmp file first,
   * verifying it, and renaming it over the destination.
   */
  public static atomicWriteJson(filePath: string, content: string): boolean {
    if (!this.validateJson(content)) {
      logger.warn(`Rejected invalid/empty token JSON for '${path.basename(filePath)}'`);
      return false;
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 6)}`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      const stat = fs.statSync(tmpPath);
      if (stat.size < 10) {
        try { fs.unlinkSync(tmpPath); } catch {}
        return false;
      }
      // On Windows renameSync can fail if destination exists and is locked
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (renameErr) {
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch {}
        }
        fs.renameSync(tmpPath, filePath);
      }
      return true;
    } catch (err: any) {
      logger.error(`Failed atomic write for '${filePath}': ${err?.message}`);
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      return false;
    }
  }

  /**
   * Inspects all .json files in a directory and purges 0-byte or malformed files
   * so prismarine-auth never crashes on bad cache entries.
   */
  public static sanitizeDirectory(dirPath: string): number {
    if (!fs.existsSync(dirPath)) return 0;
    let purged = 0;
    try {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const fullPath = path.join(dirPath, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < 10) {
            fs.unlinkSync(fullPath);
            purged++;
            logger.warn(`Purged 0-byte/empty token cache file: ${entry}`);
            continue;
          }
          const content = fs.readFileSync(fullPath, 'utf8');
          if (!this.validateJson(content)) {
            fs.unlinkSync(fullPath);
            purged++;
            logger.warn(`Purged corrupt token cache file: ${entry}`);
          }
        } catch {
          try { fs.unlinkSync(fullPath); purged++; } catch {}
        }
      }
    } catch {}
    return purged;
  }

  /**
   * Returns a local temp folder path for this account.
   * Downloads any saved tokens from Supabase into this folder first,
   * safely verifying all tokens and discarding corrupted ones.
   */
  public static async ensureProfilesFolder(accountId: string): Promise<string> {
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
    }

    // Clean up local temp folder and legacy ./profile/<id> folder
    this.sanitizeDirectory(folderPath);
    const legacyFolder = path.resolve(process.cwd(), 'profile', accountId);
    if (fs.existsSync(legacyFolder)) {
      this.sanitizeDirectory(legacyFolder);
    }

    // Try to restore saved tokens from Supabase
    try {
      const saved = await loadAuthToken(accountId);
      if (saved && saved.token_data) {
        // Bundled format: all files in one JSON blob
        if (saved.file_name === '__bundle__') {
          if (this.validateJson(saved.token_data)) {
            const bundled: Record<string, string> = JSON.parse(saved.token_data);
            let restored = 0;
            for (const [fileName, fileData] of Object.entries(bundled)) {
              if (!this.validateJson(fileData)) continue;
              const filePath = path.join(folderPath, fileName);
              // If file is missing or invalid on disk, restore atomically
              let needsRestore = true;
              if (fs.existsSync(filePath)) {
                try {
                  const existing = fs.readFileSync(filePath, 'utf8');
                  if (this.validateJson(existing)) {
                    needsRestore = false;
                  }
                } catch {
                  needsRestore = true;
                }
              }
              if (needsRestore) {
                if (this.atomicWriteJson(filePath, fileData)) {
                  restored++;
                }
              }
            }
            if (restored > 0) {
              logger.info(`Restored ${restored} auth token(s) for '${accountId}' from Supabase`, accountId);
            }
          }
        } else {
          // Legacy single-file format
          if (this.validateJson(saved.token_data)) {
            const filePath = path.join(folderPath, saved.file_name);
            let needsRestore = true;
            if (fs.existsSync(filePath)) {
              try {
                const existing = fs.readFileSync(filePath, 'utf8');
                if (this.validateJson(existing)) needsRestore = false;
              } catch {}
            }
            if (needsRestore && this.atomicWriteJson(filePath, saved.token_data)) {
              logger.info(`Restored auth token for '${accountId}' from Supabase`, accountId);
            }
          }
        }
      }
    } catch (err: any) {
      logger.debug(`Token restore for '${accountId}': ${err?.message}`);
    }

    return folderPath;
  }

  /**
   * Syncs all token files in a profile folder to Supabase.
   * Call this after a bot successfully authenticates.
   * Performs deep validation — will NEVER upload empty or corrupted files to Supabase.
   */
  public static async syncToSupabase(accountId: string, nodeId: string): Promise<void> {
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) return;

    // First purge any corrupted partial files before syncing
    this.sanitizeDirectory(folderPath);

    try {
      const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.json'));
      if (files.length === 0) return;

      const bundled: Record<string, string> = {};
      let hasValidCredentials = false;

      for (const file of files) {
        const filePath = path.join(folderPath, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          if (this.validateJson(content)) {
            bundled[file] = content;
            // Check for presence of real tokens/identities
            if (
              content.includes('access_token') ||
              content.includes('token') ||
              content.includes('mca') ||
              content.includes('userXUID') ||
              content.includes('user_hash')
            ) {
              hasValidCredentials = true;
            }
          }
        } catch {}
      }

      // Do not overwrite Supabase unless we have at least one file with valid credentials
      if (!hasValidCredentials || Object.keys(bundled).length === 0) {
        logger.debug(`Skipping Supabase token sync for '${accountId}' (no verified credentials to bundle)`);
        return;
      }

      await saveAuthToken(accountId, nodeId, '__bundle__', JSON.stringify(bundled));
      logger.info(`Synced ${Object.keys(bundled).length} verified auth token(s) for '${accountId}' to Supabase`, accountId);
    } catch (err: any) {
      logger.debug(`Token sync for '${accountId}': ${err?.message}`);
    }
  }

  /**
   * Checks whether a usable auth token cache exists for this account.
   */
  public static async hasCachedToken(accountId: string): Promise<boolean> {
    // Check Supabase first
    try {
      const saved = await loadAuthToken(accountId);
      if (saved && this.validateJson(saved.token_data)) return true;
    } catch {}

    // Fallback: check local temp dir
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (fs.existsSync(folderPath)) {
      this.sanitizeDirectory(folderPath);
      if (fs.readdirSync(folderPath).some(f => f.endsWith('.json'))) return true;
    }

    // Also check legacy ./profile/<id>
    const legacyFolder = path.resolve(process.cwd(), 'profile', accountId);
    if (fs.existsSync(legacyFolder)) {
      this.sanitizeDirectory(legacyFolder);
      if (fs.readdirSync(legacyFolder).some(f => f.endsWith('.json'))) return true;
    }

    return false;
  }

  /**
   * Clears all auth tokens — both local temp dirs and Supabase.
   */
  public static async clearTokens(accountId: string): Promise<void> {
    // Remove Supabase record
    try {
      await deleteAuthToken(accountId);
    } catch {}

    // Remove temp folder
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (fs.existsSync(folderPath)) {
      try {
        fs.rmSync(folderPath, { recursive: true, force: true });
      } catch {}
    }

    // Remove legacy ./profile/<id> folder
    const legacyFolder = path.resolve(process.cwd(), 'profile', accountId);
    if (fs.existsSync(legacyFolder)) {
      try {
        fs.rmSync(legacyFolder, { recursive: true, force: true });
      } catch {}
    }

    logger.info(`Cleared cached auth tokens for '${accountId}'`, accountId);
  }

  /**
   * Transfers tokens to a new node — updates node_id in Supabase but KEEPS the tokens.
   * Only removes local files.
   */
  public static async transferTokens(accountId: string, newNodeId: string): Promise<void> {
    try {
      await transferAuthToken(accountId, newNodeId);
      logger.info(`Transferred auth tokens for '${accountId}' to node '${newNodeId}'`, accountId);
    } catch (err: any) {
      logger.debug(`Token transfer for '${accountId}': ${err?.message}`);
    }

    // Remove local temp files
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (fs.existsSync(folderPath)) {
      try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch {}
    }
    const legacyFolder = path.resolve(process.cwd(), 'profile', accountId);
    if (fs.existsSync(legacyFolder)) {
      try { fs.rmSync(legacyFolder, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Returns the local temp folder path (synchronous, for passing to prismarine-auth).
   */
  public static getLocalProfilesFolder(accountId: string): string {
    if (path.isAbsolute(accountId) && accountId.startsWith(PROFILES_BASE)) {
      if (!fs.existsSync(accountId)) {
        fs.mkdirSync(accountId, { recursive: true, mode: 0o700 });
      }
      return accountId;
    }
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
    }
    return folderPath;
  }

  /**
   * Normalizes any input token structure (raw string, parsed JSON, or nested object)
   * into a verified Record<string, string> map of filename -> valid JSON string.
   */
  public static normalizeAndValidateTokenBundle(rawTokens: any): Record<string, string> | null {
    if (!rawTokens) return null;

    let parsed = rawTokens;
    if (typeof rawTokens === 'string') {
      try {
        parsed = JSON.parse(rawTokens.trim());
      } catch {
        return null;
      }
    }

    if (!parsed || typeof parsed !== 'object') return null;

    // If wrapped in a .tokens or .token_data property, unwrap it
    if (parsed.tokens) parsed = parsed.tokens;
    else if (parsed.token_data) {
      if (typeof parsed.token_data === 'string') {
        try { parsed = JSON.parse(parsed.token_data); } catch { return null; }
      } else {
        parsed = parsed.token_data;
      }
    }

    if (typeof parsed !== 'object' || parsed === null) return null;

    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        if (this.validateJson(value)) {
          normalized[key] = value;
        }
      } else if (typeof value === 'object' && value !== null) {
        try {
          const str = JSON.stringify(value);
          if (this.validateJson(str)) {
            normalized[key] = str;
          }
        } catch {}
      }
    }

    if (Object.keys(normalized).length === 0) return null;
    return normalized;
  }

  /**
   * Exports tokens for a single account or all accounts in a portable JSON format.
   */
  public static async exportTokens(targetAccountId?: string): Promise<{
    success: boolean;
    version: number;
    type: string;
    exportedAt: string;
    accounts: Array<{ accountId: string; email: string; nodeId: string; tokens: Record<string, string> }>;
  }> {
    const isSingle = Boolean(targetAccountId && targetAccountId !== 'all');
    const allAccounts = await getAllAccounts().catch(() => []);
    const accountMap = new Map<string, any>();
    for (const acc of allAccounts) {
      if (acc.id) accountMap.set(String(acc.id), acc);
    }

    const exportedAccounts: Array<{ accountId: string; email: string; nodeId: string; tokens: Record<string, string> }> = [];

    if (isSingle) {
      const accId = String(targetAccountId);
      const saved = await loadAuthToken(accId);
      let bundle: Record<string, string> | null = null;
      if (saved && saved.token_data) {
        bundle = this.normalizeAndValidateTokenBundle(saved.token_data);
      }
      // If not found in Supabase, try local disk
      if (!bundle) {
        const localDir = this.getLocalProfilesFolder(accId);
        if (fs.existsSync(localDir)) {
          const files = fs.readdirSync(localDir).filter(f => f.endsWith('.json'));
          const localBundle: Record<string, string> = {};
          for (const f of files) {
            try {
              const content = fs.readFileSync(path.join(localDir, f), 'utf8');
              if (this.validateJson(content)) localBundle[f] = content;
            } catch {}
          }
          if (Object.keys(localBundle).length > 0) bundle = localBundle;
        }
      }

      if (bundle) {
        const accInfo = accountMap.get(accId);
        exportedAccounts.push({
          accountId: accId,
          email: accInfo?.email || '',
          nodeId: saved?.node_id || accInfo?.node_id || '',
          tokens: bundle,
        });
      }
    } else {
      // Export all accounts
      const allTokens = await getAllAuthTokens().catch(() => []);
      const handled = new Set<string>();

      for (const tok of allTokens) {
        if (!tok.account_id || !tok.token_data) continue;
        const accId = String(tok.account_id);
        const bundle = this.normalizeAndValidateTokenBundle(tok.token_data);
        if (bundle) {
          const accInfo = accountMap.get(accId);
          exportedAccounts.push({
            accountId: accId,
            email: accInfo?.email || '',
            nodeId: tok.node_id || accInfo?.node_id || '',
            tokens: bundle,
          });
          handled.add(accId);
        }
      }

      // Check local profiles for any that were not in Supabase
      try {
        if (fs.existsSync(PROFILES_BASE)) {
          const dirs = fs.readdirSync(PROFILES_BASE);
          for (const d of dirs) {
            if (handled.has(d)) continue;
            const fullDir = path.join(PROFILES_BASE, d);
            if (fs.statSync(fullDir).isDirectory()) {
              const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.json'));
              const localBundle: Record<string, string> = {};
              for (const f of files) {
                try {
                  const content = fs.readFileSync(path.join(fullDir, f), 'utf8');
                  if (this.validateJson(content)) localBundle[f] = content;
                } catch {}
              }
              if (Object.keys(localBundle).length > 0) {
                const accInfo = accountMap.get(d);
                exportedAccounts.push({
                  accountId: d,
                  email: accInfo?.email || '',
                  nodeId: accInfo?.node_id || '',
                  tokens: localBundle,
                });
                handled.add(d);
              }
            }
          }
        }
      } catch {}
    }

    return {
      success: true,
      version: 1,
      type: 'donut-bots-tokens',
      exportedAt: new Date().toISOString(),
      accounts: exportedAccounts,
    };
  }

  /**
   * Imports tokens for an account, stores them in Supabase and writes locally if on target node.
   */
  public static async importAccountTokens(
    accountId: string,
    email: string,
    rawTokens: any,
    targetNodeId: string,
    currentNodeId?: string
  ): Promise<{ success: boolean; accountId: string; fileCount?: number; error?: string }> {
    const cleanId = String(accountId || '').trim();
    if (!cleanId) return { success: false, accountId: '', error: 'Account ID is required' };

    const bundle = this.normalizeAndValidateTokenBundle(rawTokens);
    if (!bundle || Object.keys(bundle).length === 0) {
      return { success: false, accountId: cleanId, error: 'Token data is empty or does not contain valid JSON cache files' };
    }

    const node = targetNodeId || currentNodeId || 'node-1';
    const cleanEmail = (email || '').trim();

    try {
      // 1. Save bundle into Supabase auth_tokens
      await saveAuthToken(cleanId, node, '__bundle__', JSON.stringify(bundle));

      // 2. Upsert account row into Supabase accounts table
      await upsertAccount({
        id: cleanId,
        email: cleanEmail,
        node_id: node,
        status: 'DISCONNECTED',
      });

      // 3. If target node matches this node, write directly to local profiles directory
      if (!currentNodeId || node === currentNodeId) {
        const folder = this.getLocalProfilesFolder(cleanId);
        let restoredCount = 0;
        for (const [fileName, fileContent] of Object.entries(bundle)) {
          const filePath = path.join(folder, fileName);
          if (this.atomicWriteJson(filePath, fileContent)) {
            restoredCount++;
          }
        }
        logger.info(`Imported ${restoredCount} token file(s) for account '${cleanId}' locally on ${node}`, cleanId);
      }

      return { success: true, accountId: cleanId, fileCount: Object.keys(bundle).length };
    } catch (err: any) {
      logger.error(`Failed to import tokens for '${cleanId}': ${err.message}`);
      return { success: false, accountId: cleanId, error: err.message };
    }
  }
}
