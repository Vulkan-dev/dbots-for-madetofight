import { logger } from '../utils/logger';
import { updateAccountFields } from '../database/SupabaseClient';

// AFK spot is stored directly on the account row in Supabase.
// This module provides the same interface as the old file-based LocationStorage.

export interface AfkSpot {
  x: number;
  y: number;
  z: number;
}

export const LocationStorage = {
  /**
   * Saves (or clears) the AFK spot for an account.
   */
  async setAfkSpot(accountId: string, nodeId: string, spot: AfkSpot | null): Promise<void> {
    try {
      await updateAccountFields(accountId, {
        afk_spot: spot,
        afk_spot_active: spot !== null,
      });
    } catch (err: any) {
      logger.debug(`LocationStorage.setAfkSpot [${accountId}]: ${err?.message}`);
    }
  },
};
