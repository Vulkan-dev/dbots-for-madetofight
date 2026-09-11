import { logger } from '../utils/logger';
import { loadConfig } from '../config';
import {
  getPermissions,
  addPermission,
  removePermission,
} from '../database/SupabaseClient';

// In-memory cache to avoid hitting Supabase on every message
let _cached: { user_id: string; tag: string }[] = [];
let _initialized = false;

async function ensureLoaded(): Promise<void> {
  if (_initialized) return;
  try {
    const nodeId = loadConfig().nodeId;
    _cached = await getPermissions(nodeId);
    _initialized = true;
  } catch (err: any) {
    logger.debug(`PermissionStorage init: ${err?.message}`);
    _initialized = true; // don't loop on failure
  }
}

export const PermissionStorage = {
  async getAllAllowedUsers(): Promise<{ userId: string; tag: string }[]> {
    await ensureLoaded();
    return _cached.map(r => ({ userId: r.user_id, tag: r.tag }));
  },

  async isAllowed(userId: string): Promise<boolean> {
    await ensureLoaded();
    return _cached.some(r => r.user_id === userId);
  },

  async addAllowedUser(userId: string, tag: string): Promise<boolean> {
    await ensureLoaded();
    const nodeId = loadConfig().nodeId;
    try {
      await addPermission(nodeId, userId.trim(), tag || '');
      if (!_cached.some(r => r.user_id === userId)) {
        _cached.push({ user_id: userId.trim(), tag: tag || '' });
      }
      return true;
    } catch (err: any) {
      logger.debug(`PermissionStorage.add: ${err?.message}`);
      return false;
    }
  },

  async removeAllowedUser(userId: string): Promise<boolean> {
    await ensureLoaded();
    try {
      await removePermission(userId.trim());
      _cached = _cached.filter(r => r.user_id !== userId.trim());
      return true;
    } catch (err: any) {
      logger.debug(`PermissionStorage.remove: ${err?.message}`);
      return false;
    }
  },

  // Reset cache so next call re-fetches from Supabase
  invalidate(): void {
    _initialized = false;
    _cached = [];
  },
};
