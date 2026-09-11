import { logger } from '../utils/logger';
import { loadConfig } from '../config';
import {
  getIgnoreList,
  addToIgnoreList,
  removeFromIgnoreList,
} from '../database/SupabaseClient';

let _cached: string[] = [];
let _initialized = false;

async function ensureLoaded(): Promise<void> {
  if (_initialized) return;
  try {
    const nodeId = loadConfig().nodeId;
    _cached = await getIgnoreList(nodeId);
    _initialized = true;
  } catch (err: any) {
    logger.debug(`IgnoreListStorage init: ${err?.message}`);
    _initialized = true;
  }
}

export const IgnoreListStorage = {
  async getIgnoredPlayers(): Promise<string[]> {
    await ensureLoaded();
    return [..._cached];
  },

  async isIgnored(playerName: string): Promise<boolean> {
    await ensureLoaded();
    return _cached.includes(playerName.toLowerCase());
  },

  async addPlayer(playerName: string): Promise<boolean> {
    await ensureLoaded();
    const name = playerName.toLowerCase().trim();
    if (_cached.includes(name)) return false;
    try {
      const nodeId = loadConfig().nodeId;
      await addToIgnoreList(nodeId, name);
      _cached.push(name);
      return true;
    } catch (err: any) {
      logger.debug(`IgnoreListStorage.add: ${err?.message}`);
      return false;
    }
  },

  async removePlayer(playerName: string): Promise<boolean> {
    await ensureLoaded();
    const name = playerName.toLowerCase().trim();
    if (!_cached.includes(name)) return false;
    try {
      await removeFromIgnoreList(name);
      _cached = _cached.filter(p => p !== name);
      return true;
    } catch (err: any) {
      logger.debug(`IgnoreListStorage.remove: ${err?.message}`);
      return false;
    }
  },

  invalidate(): void {
    _initialized = false;
    _cached = [];
  },
};
