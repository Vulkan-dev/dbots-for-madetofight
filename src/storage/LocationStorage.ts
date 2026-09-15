import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { updateAccountFields } from '../database/SupabaseClient';

export interface AfkSpot {
  x: number;
  y: number;
  z: number;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');

// In-memory cache for synchronous instant access
const memoryCache = new Map<string, AfkSpot>();

function ensureStorageDir(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch {}
}

function loadFromDisk(): void {
  try {
    ensureStorageDir();
    if (fs.existsSync(LOCATIONS_FILE)) {
      const raw = fs.readFileSync(LOCATIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [accId, spot] of Object.entries(parsed)) {
          if (spot && typeof (spot as any).x === 'number') {
            memoryCache.set(accId, spot as AfkSpot);
          }
        }
      }
    }
  } catch (err: any) {
    logger.debug(`LocationStorage loadFromDisk error: ${err?.message}`);
  }
}

function saveToDisk(): void {
  try {
    ensureStorageDir();
    const obj: Record<string, AfkSpot> = {};
    for (const [k, v] of memoryCache.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err: any) {
    logger.debug(`LocationStorage saveToDisk error: ${err?.message}`);
  }
}

// Initial load
loadFromDisk();

export const LocationStorage = {
  /**
   * Retrieves the saved AFK spot for an account synchronously from cache/disk.
   */
  getLocation(accountId: string): AfkSpot | null {
    if (memoryCache.has(accountId)) {
      return memoryCache.get(accountId) || null;
    }
    // Re-check disk in case another process updated it
    loadFromDisk();
    return memoryCache.get(accountId) || null;
  },

  /**
   * Saves (or clears) the AFK spot for an account to memory, disk, and Supabase.
   */
  async setAfkSpot(accountId: string, nodeId: string, spot: AfkSpot | null): Promise<void> {
    if (spot) {
      memoryCache.set(accountId, spot);
    } else {
      memoryCache.delete(accountId);
    }
    saveToDisk();

    try {
      await updateAccountFields(accountId, {
        afk_spot: spot,
        afk_spot_active: spot !== null,
      });
    } catch (err: any) {
      logger.debug(`LocationStorage.setAfkSpot [${accountId}]: ${err?.message}`);
    }
  },

  saveLocation(accountId: string, spot: AfkSpot): void {
    this.setAfkSpot(accountId, 'node-1', spot).catch(() => {});
  },

  removeLocation(accountId: string): void {
    this.setAfkSpot(accountId, 'node-1', null).catch(() => {});
  },

  /**
   * Populates location storage from Supabase account rows on node startup.
   */
  populateFromSupabase(accounts: Array<{ id: string; afk_spot?: any; afk_spot_active?: boolean }>): void {
    let changed = false;
    for (const acc of accounts) {
      if (acc.afk_spot && acc.afk_spot_active !== false && typeof acc.afk_spot.x === 'number') {
        memoryCache.set(acc.id, {
          x: Math.round(acc.afk_spot.x),
          y: Math.round(acc.afk_spot.y),
          z: Math.round(acc.afk_spot.z),
        });
        changed = true;
      } else if (memoryCache.has(acc.id) && (!acc.afk_spot || acc.afk_spot_active === false)) {
        // Disk had a saved AFK spot that was missing or null in Supabase — re-sync disk spot to Supabase
        const diskSpot = memoryCache.get(acc.id);
        if (diskSpot) {
          updateAccountFields(acc.id, {
            afk_spot: diskSpot,
            afk_spot_active: true,
          }).catch(() => {});
        }
      }
    }
    if (changed) {
      saveToDisk();
      logger.info(`Loaded persistent AFK spots for ${memoryCache.size} bot(s) from Supabase.`);
    }
  },
};
