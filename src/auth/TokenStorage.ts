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

    // Try to restore saved tokens from Supabase
    try {
      const saved = await loadAuthToken(accountId);
      if (saved) {
        // New bundled format: all files in one JSON blob
        if (saved.file_name === '__bundle__') {
          const bundled: Record<string, string> = JSON.parse(saved.token_data);
          let restored = 0;
          for (const [fileName, fileData] of Object.entries(bundled)) {
            const filePath = path.join(folderPath, fileName);
            if (!fs.existsSync(filePath)) {
              fs.writeFileSync(filePath, fileData, 'utf8');
              restored++;
            }
          }
          if (restored > 0) {
            logger.info(`Restored ${restored} auth token(s) for '${accountId}' from Supabase`, accountId);
          }
        } else {
          // Legacy single-file format
          const filePath = path.join(folderPath, saved.file_name);
          if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, saved.token_data, 'utf8');
            logger.info(`Restored auth token for '${accountId}' from Supabase`, accountId);
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
   * Stores ALL cache files as a single JSON blob (prismarine-auth needs msa + xbl + xsts + bed-cache).
   */
  public static async syncToSupabase(accountId: string, nodeId: string): Promise<void> {
    const folderPath = path.join(PROFILES_BASE, accountId);
    if (!fs.existsSync(folderPath)) return;

    try {
      const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.json'));
      if (files.length === 0) return;

      // Bundle all JSON files into a single object: { "filename": "contents", ... }
      const bundled: Record<string, string> = {};
      for (const file of files) {
        bundled[file] = fs.readFileSync(path.join(folderPath, file), 'utf8');
      }

      await saveAuthToken(accountId, nodeId, '__bundle__', JSON.stringify(bundled));
      logger.info(`Synced ${files.length} auth token(s) for '${accountId}' to Supabase`, accountId);
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
    // If already an absolute path under PROFILES_BASE, use as-is (avoid doubling)
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
}
