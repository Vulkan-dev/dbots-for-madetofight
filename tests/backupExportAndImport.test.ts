import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import { TokenStorage } from '../src/auth/TokenStorage';
import { WebServer } from '../src/web/WebServer';
import { AccountManager } from '../src/network/AccountManager';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function httpRequest(options: http.RequestOptions, bodyData?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ status: res.statusCode || 200, body: parsed });
        } catch {
          resolve({ status: res.statusCode || 200, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('Running System Database Backup Export & Import Unit Tests...\n');

  const testAccId = 'backup-test-bot-1';
  const testAccId2 = 'backup-test-bot-2';
  const mockTokens = {
    'mca-cache.json': {
      token_type: 'Bearer',
      access_token: 'mock_backup_token_123',
      expires_in: 3600,
    },
    'live-cache.json': {
      client_id: 'mock_client_backup_xyz',
      user_hash: 'mock_hash_backup_789',
    },
  };

  // ── Test 1: Pre-populate token on disk ──────────────────────────────────
  console.log('--- Test 1: Write initial tokens to disk ---');
  const importRes = await TokenStorage.importTokensForAccount(testAccId, 'test-node-1', mockTokens);
  assert(importRes.success === true, `Expected import success, got ${JSON.stringify(importRes)}`);
  console.log('✔ Test 1 Passed: Initial token cache prepared.');

  // ── Test 2: In-Process WebServer Setup ──────────────────────────────────
  console.log('\n--- Test 2: Start WebServer on test port ---');
  const testPort = 38923;
  const config: any = {
    nodeId: 'test-node-1',
    nodeName: 'Test Primary Node',
    nodeOwner: 'Admin',
    nodeUrl: 'http://localhost:38923',
    supabase: { url: '', serviceRoleKey: '' },
    server: { host: 'localhost', port: 19132, offline: false },
    webServer: { port: testPort, frontendUrl: '*', apiSecret: '' },
    discord: { isMaster: false, token: '', botCategoryId: '', allowedUserId: '', logChannelId: '', joinLogChannelId: '', leftLogChannelId: '' },
    afk: { enabled: true, activityIntervalMs: 5000, checkIntervalMs: 300000, locationTolerance: 3 },
    defensiveCombat: { enabled: false, allowedMobs: [], mobBlacklist: [], combatRange: 3 },
    playerHitResponse: { enabled: false, crouchCount: 2, cooldownMs: 1000 },
    joinScheduler: { minDelayMs: 100, maxDelayMs: 200 },
    watchdog: { reconnectDelayMs: 1000 },
    monitoring: { radiusChunks: 4, positionThresholdBlocks: 2 },
  };

  const manager = new AccountManager(config);
  await manager.instantiateBot({
    id: testAccId,
    email: 'backup1@donut.local',
    nodeId: 'test-node-1',
    autoConnect: false,
    offline: false,
    profilesFolder: '',
  });

  const server = new WebServer(manager, config);
  const expressApp = (server as any).app;
  const httpServer = http.createServer(expressApp);

  await new Promise<void>((resolve) => {
    httpServer.listen(testPort, '127.0.0.1', () => resolve());
  });
  console.log(`✔ Test 2 Passed: WebServer listening on port ${testPort}.`);

  try {
    // ── Test 3: GET /api/backup/export ────────────────────────────────────
    console.log('\n--- Test 3: GET /api/backup/export ---');
    const resExport = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/backup/export',
      method: 'GET',
    });

    assert(resExport.status === 200, `Expected 200, got ${resExport.status}`);
    assert(resExport.body.success === true, 'Response body success must be true');
    assert(resExport.body.backup !== undefined, 'backup object must be returned');
    assert(Array.isArray(resExport.body.backup.tables.accounts), 'tables.accounts must be an array');
    assert(Array.isArray(resExport.body.backup.tables.nodes), 'tables.nodes must be an array');
    assert(Array.isArray(resExport.body.backup.tables.tokens), 'tables.tokens must be an array');
    assert(resExport.body.backup.tables.nodes.length >= 1, 'At least 1 node in backup');
    assert(resExport.body.backup.tables.accounts.some((a: any) => a.id === testAccId), `Account ${testAccId} must be in backup`);
    assert(resExport.body.backup.tables.tokens.some((t: any) => t.account_id === testAccId), `Tokens for ${testAccId} must be in backup`);
    console.log(`✔ Test 3 Passed: GET /api/backup/export successfully exported critical tables (${resExport.body.counts.accounts} accounts, ${resExport.body.counts.nodes} nodes, ${resExport.body.counts.tokens} tokens).`);

    // ── Test 4: POST /api/backup/import ───────────────────────────────────
    console.log('\n--- Test 4: POST /api/backup/import ---');
    const backupToImport = {
      version: 1,
      type: 'donut_bots_backup',
      exportedAt: new Date().toISOString(),
      tables: {
        nodes: [
          { id: 'test-node-1', name: 'Restored Primary Node', url: 'http://localhost:38923', status: 'online' },
          { id: 'test-node-2', name: 'Restored Secondary Node', url: 'http://localhost:38924', status: 'online' },
        ],
        accounts: [
          { id: testAccId2, node_id: 'test-node-1', email: 'restored2@donut.local', status: 'IDLE', auto_connect: false },
        ],
        tokens: [
          {
            account_id: testAccId2,
            node_id: 'test-node-1',
            file_name: '__bundle__',
            token_data: JSON.stringify({
              'mca-cache.json': {
                token_type: 'Bearer',
                access_token: 'restored_token_val_456',
              },
            }),
          },
        ],
      },
    };

    const resImport = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/backup/import',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      },
      JSON.stringify(backupToImport)
    );

    assert(resImport.status === 200, `Expected 200, got ${resImport.status}`);
    assert(resImport.body.success === true, `Expected success: true, got ${JSON.stringify(resImport.body)}`);
    assert(resImport.body.counts.tokensWrittenOnDisk >= 1, 'Tokens must be written to disk');
    assert(resImport.body.counts.botsInstantiated >= 1, 'Bot must be instantiated');
    console.log('✔ Test 4 Passed: POST /api/backup/import restored and overwrote records with token disk sync.');

    // ── Test 5: Verify disk tokens and instantiated bots ──────────────────
    console.log('\n--- Test 5: Verify imported bot presence and disk token cache ---');
    const diskTokens2 = await TokenStorage.getTokensForAccount(testAccId2);
    assert(diskTokens2 !== null, `Tokens for ${testAccId2} must be on disk`);
    assert(diskTokens2!['mca-cache.json'] !== undefined, 'mca-cache.json must exist');
    assert(diskTokens2!['mca-cache.json'].access_token === 'restored_token_val_456', 'Access token must match restored token');
    assert(manager.getBot(testAccId2) !== undefined, `Bot ${testAccId2} must be instantiated in AccountManager`);
    console.log('✔ Test 5 Passed: Bot accurately instantiated and tokens present on disk.');

    // ── Test 6: Verify roundtrip export ───────────────────────────────────
    console.log('\n--- Test 6: Verify roundtrip export reflects newly imported data ---');
    const resExport2 = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/backup/export',
      method: 'GET',
    });
    assert(resExport2.status === 200, 'Roundtrip export must return 200');
    assert(resExport2.body.backup.tables.accounts.some((a: any) => a.id === testAccId2), 'Newly imported account in export');
    assert(resExport2.body.backup.tables.tokens.some((t: any) => t.account_id === testAccId2), 'Newly imported tokens in export');
    console.log('✔ Test 6 Passed: Roundtrip verified.');

    // ── Test 7: Error handling on invalid/empty backup ────────────────────
    console.log('\n--- Test 7: Error handling on empty backup payload ---');
    const resBadImport = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/backup/import',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({ backup: { accounts: [], nodes: [], tokens: [] } })
    );
    assert(resBadImport.status === 400, `Expected 400 for empty payload, got ${resBadImport.status}`);
    assert(resBadImport.body.success === false, 'success must be false');
    // ── Test 8: GET /api/backup/secondary-status ─────────────────────────
    console.log('\n--- Test 8: GET /api/backup/secondary-status ---');
    const resSecStatus = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/backup/secondary-status',
      method: 'GET',
    });
    assert(resSecStatus.status === 200, `Expected 200, got ${resSecStatus.status}`);
    assert(typeof resSecStatus.body.configured === 'boolean', 'configured must be a boolean');
    console.log(`✔ Test 8 Passed: Secondary status returned configured=${resSecStatus.body.configured}.`);

    // ── Test 9: POST /api/backup/sync-secondary ───────────────────────────
    console.log('\n--- Test 9: POST /api/backup/sync-secondary ---');
    const resSecSync = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/backup/sync-secondary',
      method: 'POST',
    });
    assert(resSecSync.status === 200 || resSecSync.status === 500, `Expected 200 or 500, got ${resSecSync.status}`);
    assert(resSecSync.body !== undefined, 'Response body must exist');
    assert(resSecSync.body.counts !== undefined, 'Response counts must be defined');
    console.log(`✔ Test 9 Passed: Dual sync API executed safely and reported status.`);

  } finally {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    // Cleanup disk test tokens
    try {
      const p1 = path.join(os.tmpdir(), 'donut-bot-profiles', testAccId);
      const p2 = path.join(os.tmpdir(), 'donut-bot-profiles', testAccId2);
      const l1 = path.resolve(process.cwd(), 'profile', testAccId);
      const l2 = path.resolve(process.cwd(), 'profile', testAccId2);
      [p1, p2, l1, l2].forEach(dir => {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    } catch {}
  }

  console.log('\n🎉 ALL SYSTEM BACKUP EXPORT & IMPORT UNIT TESTS PASSED SUCCESSFULLY!\n');
}

runTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
