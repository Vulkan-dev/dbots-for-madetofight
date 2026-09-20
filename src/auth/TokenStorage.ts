import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';
import {
  saveAuthToken,
  loadAuthToken,
  deleteAuthToken,
  transferAuthToken,
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
   * Reads and bundles all valid token files for an account from disk or Supabase.
   * Returns an object mapping fileName -> parsed JSON data, or null if no tokens exist.
   */
  public static async getTokensForAccount(accountId: string): Promise<Record<string, any> | null> {
    const result: Record<string, any> = {};

    // 1. Check local temp directory
    const tempFolder = path.join(PROFILES_BASE, accountId);
    if (fs.existsSync(tempFolder)) {
      this.sanitizeDirectory(tempFolder);
      try {
        const files = fs.readdirSync(tempFolder).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(tempFolder, file), 'utf8');
            if (this.validateJson(raw)) {
              result[file] = JSON.parse(raw);
            }
          } catch {}
        }
      } catch {}
    }

    // 2. Check legacy profile/<accountId> directory
    const legacyFolder = path.resolve(process.cwd(), 'profile', accountId);
    if (fs.existsSync(legacyFolder)) {
      this.sanitizeDirectory(legacyFolder);
      try {
        const files = fs.readdirSync(legacyFolder).filter(f => f.endsWith('.json'));
        for (const file of files) {
          if (!result[file]) {
            try {
              const raw = fs.readFileSync(path.join(legacyFolder, file), 'utf8');
              if (this.validateJson(raw)) {
                result[file] = JSON.parse(raw);
              }
            } catch {}
          }
        }
      } catch {}
    }

    // 3. Fallback to Supabase loadAuthToken
    try {
      const saved = await loadAuthToken(accountId);
      if (saved && saved.token_data && this.validateJson(saved.token_data)) {
        if (saved.file_name === '__bundle__') {
          const parsedBundle = JSON.parse(saved.token_data);
          for (const [fileName, content] of Object.entries(parsedBundle)) {
            if (!result[fileName]) {
              try {
                result[fileName] = typeof content === 'string' ? JSON.parse(content) : content;
              } catch {
                result[fileName] = content;
              }
            }
          }
        } else {
          if (!result[saved.file_name]) {
            try {
              result[saved.file_name] = JSON.parse(saved.token_data);
            } catch {
              result[saved.file_name] = saved.token_data;
            }
          }
        }
      }
    } catch (err: any) {
      logger.debug(`getTokensForAccount [${accountId}] Supabase check: ${err?.message}`);
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Imports token data for an account, atomically writes it to both the temp
   * folder and legacy profile folder, and synchronizes the bundle to Supabase.
   */
  public static async importTokensForAccount(
    accountId: string,
    nodeId: string,
    tokens: Record<string, any>
  ): Promise<{ success: boolean; fileCount: number; error?: string }> {
    if (!tokens || typeof tokens !== 'object' || Object.keys(tokens).length === 0) {
      return { success: false, fileCount: 0, error: 'No token files found in payload' };
    }

    const tempFolder = path.join(PROFILES_BASE, accountId);
    const legacyFolder = path.resolve(process.cwd(), 'profile', accountId);

    if (!fs.existsSync(tempFolder)) {
      fs.mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(legacyFolder)) {
      fs.mkdirSync(legacyFolder, { recursive: true, mode: 0o700 });
    }

    const bundled: Record<string, string> = {};
    let writtenFiles = 0;

    for (const [fileName, tokenData] of Object.entries(tokens)) {
      let cleanName = path.basename(fileName).trim();
      if (!cleanName.endsWith('.json')) {
        cleanName += '.json';
      }

      const jsonStr = typeof tokenData === 'string'
        ? tokenData.trim()
        : JSON.stringify(tokenData, null, 2);

      if (!this.validateJson(jsonStr)) continue;

      const tempPath = path.join(tempFolder, cleanName);
      const legacyPath = path.join(legacyFolder, cleanName);

      const okTemp = this.atomicWriteJson(tempPath, jsonStr);
      const okLegacy = this.atomicWriteJson(legacyPath, jsonStr);

      if (okTemp || okLegacy) {
        bundled[cleanName] = jsonStr;
        writtenFiles++;
      }
    }

    if (writtenFiles === 0) {
      return { success: false, fileCount: 0, error: 'No valid token JSON files could be parsed or written' };
    }

    // Sync bundle to Supabase
    try {
      await saveAuthToken(accountId, nodeId, '__bundle__', JSON.stringify(bundled));
      logger.info(`Imported & synchronized ${writtenFiles} token file(s) for account '${accountId}'`, accountId);
    } catch (err: any) {
      logger.warn(`Tokens written to disk for '${accountId}', but Supabase sync returned: ${err?.message}`, accountId);
    }

    return { success: true, fileCount: writtenFiles };
  }
}
