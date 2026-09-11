import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';
import {
  saveAuthToken,
  loadAuthToken,
  deleteAuthToken,
} from '../database/SupabaseClient';

// ─── Temp directory for prismarine-auth cache files ───────────────────────────
// Railway has an ephemeral filesystem — we store the real tokens in Supabase
// and sync them to a temp directory so prismarine-auth can work normally.
// On startup: download from Supabase → temp dir
// After auth: upload from temp dir → Supabase
// ─────────────────────────────────────────────────────────────────────────────

const PROFILES_BASE = path.join(os.tmpdir(), 'donut-bot-profiles');

export class TokenStorage {
  /**
   * Returns a local temp folder path for this account.
   * Downloads any saved tokens from Supabase into this folder first.
   */
  public static async ensureProfilesFolder(accountId: string): Promise<string> {
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
    }

    // Try to restore saved token from Supabase
    try {
      const saved = await loadAuthToken(accountId);
      if (saved) {
        const filePath = path.join(folderPath, saved.file_name);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, saved.token_data, 'utf8');
          logger.info(`Restored auth token for '${accountId}' from Supabase`, accountId);
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
   */
  public static async syncToSupabase(accountId: string, nodeId: string): Promise<void> {
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) return;

    try {
      const files = fs.readdirSync(folderPath);
      // Prefer bed-cache or xbl-cache files (prismarine-auth caches)
      const cacheFile = files.find(f => f.endsWith('_bed-cache.json') || f.endsWith('_xbl-cache.json') || f.endsWith('.json'));
      if (!cacheFile) return;

      const filePath = path.join(folderPath, cacheFile);
      const tokenData = fs.readFileSync(filePath, 'utf8');
      await saveAuthToken(accountId, nodeId, cacheFile, tokenData);
      logger.info(`Synced auth token for '${accountId}' to Supabase`, accountId);
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
      if (saved) return true;
    } catch {}

    // Fallback: check local temp dir
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) return false;
    return fs.readdirSync(folderPath).some(f => f.endsWith('.json'));
  }

  /**
   * Clears all auth tokens — both local temp dir and Supabase.
   */
  public static async clearTokens(accountId: string): Promise<void> {
    // Remove Supabase record
    try {
      await deleteAuthToken(accountId);
    } catch {}

    // Remove temp files
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (fs.existsSync(folderPath)) {
      try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        logger.info(`Cleared cached auth tokens for '${accountId}'`, accountId);
      } catch {}
    }
  }

  /**
   * Returns the local temp folder path (synchronous, for passing to prismarine-auth).
   * Use ensureProfilesFolder for async init with Supabase sync.
   */
  public static getLocalProfilesFolder(accountId: string): string {
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
    }
    return folderPath;
  }
}
