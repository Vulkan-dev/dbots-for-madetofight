import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { loadConfig } from '../config';
import {
  getIgnoreList,
  addToIgnoreList,
  removeFromIgnoreList,
} from '../database/SupabaseClient';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const IGNORED_FILE = path.join(DATA_DIR, 'ignored_players.json');

let _cached: string[] = [];
let _initialized = false;

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
    if (fs.existsSync(IGNORED_FILE)) {
      const raw = fs.readFileSync(IGNORED_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        _cached = parsed
          .filter(p => typeof p === 'string' && p.trim().length > 0)
          .map(p => p.toLowerCase().trim());
      }
    }
  } catch (err: any) {
    logger.debug(`IgnoreListStorage loadFromDisk error: ${err?.message}`);
  }
}

function saveToDisk(): void {
  try {
    ensureStorageDir();
    fs.writeFileSync(IGNORED_FILE, JSON.stringify(_cached, null, 2), 'utf8');
  } catch (err: any) {
    logger.debug(`IgnoreListStorage saveToDisk error: ${err?.message}`);
  }
}

// Synchronous initial load from disk so memory is immediately available
loadFromDisk();

async function syncWithSupabase(): Promise<void> {
  if (_initialized) return;
  try {
    const fromDb = await getIgnoreList();
    let updated = false;
    for (const name of fromDb) {
      const clean = name.toLowerCase().trim();
      if (clean && !_cached.includes(clean)) {
        _cached.push(clean);
        updated = true;
      }
    }
    if (updated) {
      saveToDisk();
    }
    _initialized = true;
  } catch (err: any) {
    logger.debug(`IgnoreListStorage Supabase sync: ${err?.message}`);
    _initialized = true;
  }
}

// Trigger background async sync with Supabase
syncWithSupabase().catch(() => {});

export const IgnoreListStorage = {
  async getIgnoredPlayers(): Promise<string[]> {
    await syncWithSupabase();
    return [..._cached];
  },

  /**
   * Synchronous check if a player is on the trusted/ignored list.
   * Matches exact name or with/without Geyser/Floodgate prefixes (., _, *).
   */
  isIgnored(playerName: string): boolean {
    if (!playerName) return false;
    const name = playerName.toLowerCase().trim();
    if (_cached.includes(name)) return true;

    // Check without leading prefix (.Player or _Player or *Player)
    const stripped = name.replace(/^[._*]+/, '');
    if (_cached.includes(stripped)) return true;

    // Check if any cached entry matches the stripped name
    for (const cached of _cached) {
      const cachedStripped = cached.replace(/^[._*]+/, '');
      if (cachedStripped === stripped || cachedStripped === name) return true;
    }

    return false;
  },

  async addPlayer(playerName: string): Promise<boolean> {
    if (!playerName) return false;
    const name = playerName.toLowerCase().trim();
    if (_cached.includes(name)) return true;

    _cached.push(name);
    saveToDisk();

    try {
      const nodeId = loadConfig().nodeId;
      await addToIgnoreList(nodeId, name);
    } catch (err: any) {
      logger.debug(`IgnoreListStorage.add Supabase sync: ${err?.message}`);
    }
    return true;
  },

  async removePlayer(playerName: string): Promise<boolean> {
    if (!playerName) return false;
    const name = playerName.toLowerCase().trim();
    const stripped = name.replace(/^[._*]+/, '');

    const initialLength = _cached.length;
    _cached = _cached.filter(p => {
      const pClean = p.toLowerCase().trim();
      return pClean !== name && pClean.replace(/^[._*]+/, '') !== stripped;
    });

    saveToDisk();

    try {
      await removeFromIgnoreList(name);
      if (stripped !== name) {
        await removeFromIgnoreList(stripped);
      }
    } catch (err: any) {
      logger.debug(`IgnoreListStorage.remove Supabase sync: ${err?.message}`);
    }
    return _cached.length < initialLength;
  },

  invalidate(): void {
    _initialized = false;
    loadFromDisk();
    syncWithSupabase().catch(() => {});
  },
};
