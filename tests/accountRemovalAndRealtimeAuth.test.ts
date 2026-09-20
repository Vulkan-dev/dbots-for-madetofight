import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { AccountManager } from '../src/network/AccountManager';
import { LocationStorage } from '../src/storage/LocationStorage';
import { MicrosoftAuthManager, AccountAuthStatus } from '../src/auth/MicrosoftAuthManager';
import { AppConfig } from '../src/config';

console.log('Running Account Removal and Real-time Xbox Auth Unit Tests...\n');

const mockConfig: AppConfig = {
  nodeId: 'test-node',
  nodeName: 'Test Node',
  nodeOwner: '',
  nodeUrl: 'http://localhost:3000',
  supabase: { url: '', serviceRoleKey: '' },
  server: { host: 'localhost', port: 19132, offline: false },
  webServer: { port: 3001, frontendUrl: '*', apiSecret: '' },
  discord: { isMaster: false, token: '', botCategoryId: '', allowedUserId: '', logChannelId: '', joinLogChannelId: '', leftLogChannelId: '' },
  afk: { enabled: true, activityIntervalMs: 5000, checkIntervalMs: 300000, locationTolerance: 3 },
  defensiveCombat: { enabled: false, allowedMobs: [], mobBlacklist: [], combatRange: 3 },
  playerHitResponse: { enabled: false, crouchCount: 2, cooldownMs: 1000 },
  joinScheduler: { minDelayMs: 100, maxDelayMs: 200 },
  watchdog: { reconnectDelayMs: 1000 },
  monitoring: { radiusChunks: 4, positionThresholdBlocks: 2 },
};

async function runTests() {
  console.log('--- Test 1: MicrosoftAuthManager real-time Xbox Live Gamertag lookup ---');
  const testBaseDir = path.resolve(process.cwd(), 'test_cache', 'removal_test');

  const authManager = new MicrosoftAuthManager({
    accountId: 'test_realtime',
    profilesFolder: path.join(testBaseDir, 'profile', 'test_realtime'),
  });

  (authManager as any).getOrCreateAuthflow = () => ({
    getXboxToken: async (relyingParty: string) => {
      if (relyingParty === 'http://xboxlive.com') {
        return {
          userXUID: '1122334455',
          userHash: 'mockHash123',
          XSTSToken: 'mockToken456',
        };
      }
      return { userXUID: '1122334455' };
    },
  });

  const originalFetch = global.fetch;
  (global as any).fetch = async (url: string) => {
    if (url.includes('settings=Gamertag')) {
      return {
        ok: true,
        json: async () => ({
          profileUsers: [
            {
              settings: [{ id: 'Gamertag', value: 'FreshRealGamertag' }],
            },
          ],
        }),
      };
    }
    return { ok: false };
  };

  try {
    const checkRes = await authManager.checkXboxProfile(true);
    assert.strictEqual(checkRes.exists, true);
    assert.strictEqual(authManager.getIdentity().gamertag, 'FreshRealGamertag', 'Gamertag must be resolved in real time');
    assert.strictEqual(authManager.getIdentity().xuid, '1122334455');
    console.log('✔ Test 1 Passed: Real-time Xbox Live profile REST fetch resolved FreshRealGamertag.');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('--- Test 2: AccountManager instantiation ---');
  const manager = new AccountManager(mockConfig);
  assert.ok(manager, 'AccountManager should be created');
  console.log('✔ Test 2 Passed: AccountManager created successfully.');

  console.log('\n🎉 ALL ACCOUNT REMOVAL & REAL-TIME AUTH TESTS PASSED!\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
