import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { updateAccountFields } from '../database/SupabaseClient';

export interface BotActionState {
  isCrouching?: boolean;
  isSpamClicking?: boolean;
  updatedAt?: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ACTION_STATES_FILE = path.join(DATA_DIR, 'action_states.json');

const memoryCache = new Map<string, BotActionState>();

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
    if (fs.existsSync(ACTION_STATES_FILE)) {
      const raw = fs.readFileSync(ACTION_STATES_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [accId, state] of Object.entries(parsed)) {
          if (state && typeof state === 'object') {
            memoryCache.set(accId, state as BotActionState);
          }
        }
      }
    }
  } catch (err: any) {
    logger.debug(`PersistentActionStorage loadFromDisk error: ${err?.message}`);
  }
}

function saveToDisk(): void {
  try {
    ensureStorageDir();
    const obj: Record<string, BotActionState> = {};
    for (const [k, v] of memoryCache.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(ACTION_STATES_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err: any) {
    logger.debug(`PersistentActionStorage saveToDisk error: ${err?.message}`);
  }
}

// Initial load
loadFromDisk();

export const PersistentActionStorage = {
  isCrouched(accountId: string): boolean {
    if (!accountId) return false;
    if (memoryCache.has(accountId)) {
      return Boolean(memoryCache.get(accountId)?.isCrouching);
    }
    loadFromDisk();
    return Boolean(memoryCache.get(accountId)?.isCrouching);
  },

  getState(accountId: string): BotActionState {
    if (!accountId) return {};
    if (memoryCache.has(accountId)) {
      return memoryCache.get(accountId) || {};
    }
    loadFromDisk();
    return memoryCache.get(accountId) || {};
  },

  setCrouch(accountId: string, isCrouching: boolean): void {
    if (!accountId) return;
    const cur = memoryCache.get(accountId) || {};
    cur.isCrouching = isCrouching;
    cur.updatedAt = new Date().toISOString();
    memoryCache.set(accountId, cur);
    saveToDisk();

    // Persist to Supabase if column is available
    try {
      updateAccountFields(accountId, { is_crouching: isCrouching } as any).catch(() => {});
    } catch {}
  },

  populateFromSupabase(accounts: Array<{ id: string; is_crouching?: boolean }>): void {
    let changed = false;
    for (const acc of accounts) {
      if (typeof acc.is_crouching === 'boolean') {
        const cur = memoryCache.get(acc.id) || {};
        if (cur.isCrouching !== acc.is_crouching) {
          cur.isCrouching = acc.is_crouching;
          memoryCache.set(acc.id, cur);
          changed = true;
        }
      }
    }
    if (changed) {
      saveToDisk();
      logger.info(`Loaded persistent crouch states for ${memoryCache.size} account(s).`);
    }
  },

  clear(accountId?: string): void {
    if (accountId) {
      memoryCache.delete(accountId);
    } else {
      memoryCache.clear();
    }
    saveToDisk();
  },
};
